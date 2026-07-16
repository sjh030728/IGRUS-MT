import { Injectable } from '@nestjs/common';
import type { LedgerEntry, ScoreRow, Scoreboard, SessionId, TeamId, TeamInfo } from '@mt/protocol';

/**
 * 점수 원장. ledger.ts의 규칙 3줄을 그대로 구현한다:
 *   1. SEED  : 마지막 것만 유효 (set)
 *   2. ROUND / ADJUST : 전부 더함 (add)
 *   3. VOID 당한 seq는 건너뜀
 *
 * ★단계 1은 메모리다. Postgres는 단계 2★
 * CLAUDE.md가 DB를 "문제 은행 + 결과 아카이브 전용"으로 못 박았고, 문제 은행은
 * 단계 2에 처음 필요해진다. 원칙 4가 지키라는 건 fold 로직이지 스토리지가 아니다 —
 * 재시작 복구는 `SELECT * FROM session_ledger ORDER BY seq` → 아래 fold다.
 * 그래서 fold를 지금 짜고 append만 나중에 DB로 돌린다. 복구 코드는 따로 안 생긴다.
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
export class LedgerService {
  private readonly entries: LedgerEntry[] = [];
  private nextSeq = 1;

  /**
   * seq는 원장이 매긴다 (ids.ts: "DB가 매긴다"). 호출자는 못 정한다.
   *
   * ★이걸 DB로 돌리는 순간 docs/program-ops.md에 "서버가 죽으면" 절차가 필요해진다★
   * 지금은 못 쓴다 — 복구가 없으니 쓸 내용이 거짓이 된다. 복구를 만드는 게 이 함수라
   * 리마인더를 여기 둔다. 사람이 기억할 일이 아니다 (`0012`).
   *
   * 쓸 내용은 이미 정해져 있다: **재시작만 한다 → 점수판을 본다 → 이상하면 낮 점수를
   * 다시 넣는다.** 세 줄이면 되고 원장이 뭔지 몰라도 안전하다 — SEED가 set이라
   * 두 번 넣어도 두 배가 안 되기 때문이다(`totals()` 아래).
   */
  append(entry: NewLedgerEntry): LedgerEntry {
    const withSeq = { ...entry, seq: this.nextSeq++ } as LedgerEntry;
    this.entries.push(withSeq);
    return withSeq;
  }

  all(): readonly LedgerEntry[] {
    return this.entries;
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
