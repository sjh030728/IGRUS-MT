import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Subject } from 'rxjs';
import pg from 'pg';
import { z } from 'zod';
import { LedgerEntry, type SessionId } from '@mt/protocol';

/**
 * ═══ DB 어댑터 ═══ Postgres는 문제 은행 + 원장 아카이브 전용 (CLAUDE.md).
 *
 * ★부팅은 딱딱하게, 런타임은 부드럽게★
 *  - 부팅 때 DB가 없으면 ★크게 터진다★ — config와 같은 7:30 원칙. 도커를 안 켠 건
 *    7시 30분에 사람이 고칠 수 있는 문제고, 8:03에 퀴즈 진입이 조용히 실패하는 것보다
 *    백 배 낫다. 에러 메시지가 할 일(docker compose up -d)을 그대로 말해준다.
 *  - ★런타임에 DB가 죽으면 쇼는 계속된다★ — 원장의 진실은 메모리다(LedgerService).
 *    미러 큐가 쌓이며 재시도하고, 콘솔 health.db가 FAIL로 바뀔 뿐 점수는 계속 돈다.
 *    8시 35분에 컨테이너가 죽었다고 무대를 세울 수는 없다.
 */

/** 사람 손(시드)을 거친 데이터라 Zod로 걸러 읽는다 — config.ts와 같은 이유. */
const QuizRow = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  choices: z.array(z.string().min(1)).min(2).max(6),
  answer_index: z.number().int().nonnegative(),
  patter: z.string().nullable(),
});

export interface QuizQuestion {
  id: string;
  text: string;
  choices: string[];
  answerIndex: number;
  patter: string | null;
}

const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgres://mt:mt@localhost:5432/mt';

@Injectable()
export class DbService implements OnModuleInit, OnModuleDestroy {
  private readonly pool = new pg.Pool({ connectionString: DATABASE_URL, max: 3 });

  /** 콘솔 health.db의 근거. 마지막 쿼리가 성공했나. */
  ok = true;
  /** ok가 바뀌면 쏜다. 게이트웨이가 구독해서 콘솔 health를 갱신한다. */
  readonly status$ = new Subject<void>();

  /** 원장 미러 대기열. 실패해도 안 버린다 — DB가 돌아오면 순서대로 흘려보낸다. */
  private queue: { sessionId: SessionId; entry: LedgerEntry }[] = [];
  private draining = false;
  private retry: NodeJS.Timeout | null = null;

  async onModuleInit(): Promise<void> {
    try {
      const schema = readFileSync(fileURLToPath(new URL('../../db/schema.sql', import.meta.url)), 'utf8');
      await this.pool.query(schema);
    } catch (e) {
      throw new Error(
        `[db] Postgres에 못 붙었습니다 (${DATABASE_URL}) — ${(e as Error).message}\n` +
          `     레포 루트에서: docker compose up -d`,
      );
    }
    console.log(`[db] 연결 OK — ${DATABASE_URL.replace(/:[^:@/]+@/, ':***@')}`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.retry) clearTimeout(this.retry);
    await this.pool.end();
  }

  /** 문제 은행. enabled만, ★결정적 순서★ (game.ts: ORDER BY random() 금지). */
  async loadQuizQuestions(): Promise<QuizQuestion[]> {
    const res = await this.run(() =>
      this.pool.query('SELECT id, text, choices, answer_index, patter FROM quiz_question WHERE enabled ORDER BY position, id'),
    );
    return res.rows.map((raw) => {
      const row = QuizRow.parse(raw); // 시드가 이상하면 여기서 시끄럽게
      if (row.answer_index >= row.choices.length) {
        throw new Error(`[db] 문제 "${row.id}"의 answer_index(${row.answer_index})가 보기(${row.choices.length}개) 밖입니다`);
      }
      return { id: row.id, text: row.text, choices: row.choices, answerIndex: row.answer_index, patter: row.patter };
    });
  }

  /** 재시작 복구의 원천. 부팅 때 LedgerService가 부른다. */
  async loadLedger(sessionId: SessionId): Promise<LedgerEntry[]> {
    const res = await this.run(() =>
      this.pool.query('SELECT entry FROM session_ledger WHERE session_id = $1 ORDER BY seq', [sessionId]),
    );
    // 과거 세션 데이터가 지금 계약과 어긋나면 조용히 이상한 점수가 아니라 부팅 에러가 낫다.
    return res.rows.map((r) => LedgerEntry.parse(r.entry));
  }

  /**
   * 원장 미러 기입. ★동기가 아니다 — 커밋(리빌)을 DB 지연에 볼모로 잡히지 않는다★
   * ON CONFLICT DO NOTHING이라 재시도가 겹쳐도 두 번 안 쌓인다 (멱등).
   */
  mirrorLedger(sessionId: SessionId, entry: LedgerEntry): void {
    this.queue.push({ sessionId, entry });
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    while (this.queue.length > 0) {
      const { sessionId, entry } = this.queue[0]!;
      try {
        await this.pool.query(
          'INSERT INTO session_ledger (session_id, seq, entry) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [sessionId, entry.seq, JSON.stringify(entry)],
        );
        this.queue.shift();
        this.setOk(true);
      } catch (e) {
        this.setOk(false);
        console.error(`[db] 원장 미러 실패 (${this.queue.length}건 대기) — 메모리는 계속 간다:`, (e as Error).message);
        // 3초 뒤 재시도. 큐는 그대로 — DB가 돌아오면 밀린 걸 순서대로 흘린다.
        this.retry ??= setTimeout(() => {
          this.retry = null;
          void this.drain();
        }, 3000);
        break;
      }
    }
    this.draining = false;
  }

  private async run<T>(q: () => Promise<T>): Promise<T> {
    try {
      const r = await q();
      this.setOk(true);
      return r;
    } catch (e) {
      this.setOk(false);
      throw e;
    }
  }

  private setOk(ok: boolean): void {
    if (this.ok === ok) return;
    this.ok = ok;
    this.status$.next();
  }
}
