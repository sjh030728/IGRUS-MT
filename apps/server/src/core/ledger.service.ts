import { Injectable, OnModuleInit } from '@nestjs/common';
import type { LedgerEntry, ScoreRow, Scoreboard, SessionId, TeamId, TeamInfo } from '@mt/protocol';
import { SessionId as SessionIdSchema } from '@mt/protocol';
import { DbService } from './db.service.js';
import { loadSessionConfig } from './config.js';

/**
 * 점수 원장. ledger.ts의 규칙 3줄을 그대로 구현한다:
 *   1. SEED  : 마지막 것만 유효 (set)
 *   2. ROUND / ADJUST : 전부 더함 (add)
 *   3. VOID 당한 seq는 건너뜀
 *
 * ★진실은 메모리, DB는 미러다★ (단계 2에서 영속화 도입)
 * 읽기(totals/scoreboard)는 매 스냅샷 도는 뜨거운 경로라 전부 메모리다.
 * append는 메모리에 먼저 쌓고 DB에 비동기로 미러한다 — 커밋(리빌 직후)이
 * DB 지연에 볼모로 잡히면 안 된다. DB가 죽어도 그날 밤 점수는 계속 돈다.
 * 재시작 복구: 부팅 때 session_ledger를 읽어 이 배열을 되살린다 → fold는 그대로.
 */
/**
 * ★Omit을 판별 유니온에 그냥 걸면 안 된다★
 * `Omit<LedgerEntry, 'seq'>`는 유니온을 뭉개서 ★공통 필드만 남긴 객체 하나★로 만든다.
 * 그러면 kind:'ROUND'인데 segmentId가 없는 타입이 되어 컴파일이 막힌다 — 실제로 막혔다.
 * 조건부 타입은 유니온에 분배되므로 T extends unknown 한 겹이 각 멤버에 따로 Omit을 건다.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** seq 빼고 전부. seq는 원장이 매긴다. */
export type NewLedgerEntry = DistributiveOmit<LedgerEntry, 'seq'>;

@Injectable()
export class LedgerService implements OnModuleInit {
  private entries: LedgerEntry[] = [];
  private nextSeq = 1;
  private readonly sessionId: SessionId;

  constructor(private readonly db: DbService) {
    this.sessionId = SessionIdSchema.parse(loadSessionConfig().sessionId);
  }

  /**
   * ★재시작 복구가 이 몇 줄이 전부다★ (원칙 4)
   * 프로세스가 죽어도 확정 점수는 DB에 있다. 다시 읽어 배열만 되살리면
   * totals/scoreboard는 아무것도 모른 채 그대로 돈다. 진행 중이던 라운드는
   * 복구하지 않는다 — "사회자가 다시 제시한다(20초)" (ledger.ts).
   */
  async onModuleInit(): Promise<void> {
    this.entries = await this.db.loadLedger(this.sessionId);
    this.nextSeq = (this.entries[this.entries.length - 1]?.seq ?? 0) + 1;
    if (this.entries.length > 0) {
      console.log(`[ledger] 복구 — 기입 ${this.entries.length}건 (seq ${this.nextSeq - 1}까지). 점수판이 이어진다.`);
    }
  }

  /** seq는 원장이 매긴다. 호출자는 못 정한다. 미러 실패는 여길 막지 않는다 (db.service). */
  append(entry: NewLedgerEntry): LedgerEntry {
    const withSeq = { ...entry, seq: this.nextSeq++ } as LedgerEntry;
    this.entries.push(withSeq);
    this.db.mirrorLedger(this.sessionId, withSeq);
    return withSeq;
  }

  all(): readonly LedgerEntry[] {
    return this.entries;
  }

  // ── 콘솔 점수 도구 3종 (단계 4). 전부 기입일 뿐이다 — UPDATE도 DELETE도 없다 ──

  /** 낮 야외 PG 점수. ★유일한 set 의미★ — 오타 나면 그냥 다시 입력한다 (ledger.ts SeedEntry). */
  seedSet(totals: Record<string, number>, note?: string): void {
    this.append({ kind: 'SEED', sessionId: this.sessionId, at: Date.now(), by: 'HOST', totals, ...(note !== undefined ? { note } : {}) });
  }

  /** 점수 수동 보정. 번역 릴레이 채점도, 치터 감점도 전부 이것. reason 필수는 계약이 강제한다. */
  adjust(deltas: Record<string, number>, reason: string): void {
    this.append({ kind: 'ADJUST', sessionId: this.sessionId, at: Date.now(), by: 'HOST', deltas, reason });
  }

  /**
   * 되감기. 삭제가 아니라 VOID 기입 추가 — 빔에 점수가 ★내려가는 게 보인다★ (연출 선택).
   * 검증이 여기 사는 이유: 원장 내용을 아는 건 원장뿐이다.
   */
  voidSeq(seq: number, reason: string): { ok: true } | { ok: false; message: string } {
    const target = this.entries.find((e) => e.seq === seq);
    if (!target) return { ok: false, message: `기입 #${seq} 없음` };
    if (target.kind === 'SEED') return { ok: false, message: 'SEED는 되감기 대상이 아니다 — 다시 입력해서 덮는다' };
    if (target.kind === 'VOID') return { ok: false, message: 'VOID의 VOID 금지 — 살리려면 같은 내용을 새로 기입' };
    if (this.entries.some((e) => e.kind === 'VOID' && e.voidsSeq === seq)) {
      return { ok: false, message: `#${seq}은 이미 무효` }; // 두 번 무효 = 장부 소음. 멱등이 아니라 거절이다
    }
    this.append({ kind: 'VOID', sessionId: this.sessionId, at: Date.now(), by: 'HOST', voidsSeq: seq, reason });
    return { ok: true };
  }

  /** 콘솔의 되감기 UI가 여기서 seq를 고른다. */
  tail(n: number): readonly LedgerEntry[] {
    return this.entries.slice(-n);
  }

  /** ★이 함수가 채점 모델 전부다★ */
  totals(teams: readonly TeamInfo[]): Record<TeamId, number> {
    const voided = new Set<number>();
    for (const e of this.entries) if (e.kind === 'VOID') voided.add(e.voidsSeq);

    // SEED는 set 의미라 마지막 것만 본다. 나머지 add의 출발점이 된다.
    let seed: Record<string, number> = {};
    for (const e of this.entries) if (e.kind === 'SEED') seed = e.totals;

    const out = {} as Record<TeamId, number>;
    for (const t of teams) out[t.teamId] = seed[t.teamId] ?? 0;

    for (const e of this.entries) {
      if (voided.has(e.seq)) continue;
      const deltas = e.kind === 'ROUND' ? e.appliedDeltas : e.kind === 'ADJUST' ? e.deltas : null;
      if (!deltas) continue;
      for (const [teamId, d] of Object.entries(deltas)) {
        const key = teamId as TeamId;
        if (key in out) out[key] = (out[key] ?? 0) + d;
      }
    }
    return out;
  }

  /**
   * 빔에 상시 노출되는 점수판.
   * ★rank는 서버가 계산한다★ session.ts: "클라 3개가 각자 정렬하면 동점 처리가 어긋난다."
   */
  scoreboard(teams: readonly TeamInfo[]): Scoreboard {
    const totals = this.totals(teams);
    const last = this.lastDeltas();

    const sorted = [...teams].sort((a, b) => (totals[b.teamId] ?? 0) - (totals[a.teamId] ?? 0));
    const rows: ScoreRow[] = [];
    let rank = 0;
    let prevTotal: number | null = null;
    sorted.forEach((t, i) => {
      const total = totals[t.teamId] ?? 0;
      // 동점은 같은 등수. 다음 등수는 건너뛴다 (1,1,3).
      if (prevTotal === null || total !== prevTotal) rank = i + 1;
      prevTotal = total;
      rows.push({
        teamId: t.teamId,
        name: t.name,
        color: t.color,
        total,
        rank,
        lastDelta: last[t.teamId] ?? null,
      });
    });

    return { rows, throughSeq: this.nextSeq - 1 };
  }

  /**
   * 직전 확정 기입의 델타. 점수 애니메이션이 이걸로 굴러간다 (session.ts ScoreRow.lastDelta).
   * ★무효화된 기입은 안 본다★ — 되감기 직후에 사라진 점수가 다시 튀면 안 된다.
   */
  private lastDeltas(): Record<string, number> {
    const voided = new Set<number>();
    for (const e of this.entries) if (e.kind === 'VOID') voided.add(e.voidsSeq);

    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i]!;
      if (voided.has(e.seq)) continue;
      if (e.kind === 'ROUND') return e.appliedDeltas;
      if (e.kind === 'ADJUST') return e.deltas;
    }
    return {};
  }
}
