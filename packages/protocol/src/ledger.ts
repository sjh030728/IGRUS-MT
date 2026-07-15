import { z } from 'zod';
import { EpochMs, GameId, MatchId, RoundId, SegmentId, Seq, SessionId, TeamId } from './ids.js';

/**
 * 점수 원장(ledger).
 *
 * 점수를 변수에 넣고 덮어쓰는 게 아니라, 은행 통장처럼 "기입"만 계속 쌓고
 * 필요할 때 처음부터 다 더해서 현재 점수를 낸다. UPDATE도 DELETE도 없다.
 *
 * 왜 이렇게까지 하냐:
 *
 * 1. CLAUDE.md 원칙 4: "로컬 프로세스가 죽어서 점수가 전부 날아가는 게 실제 시나리오다."
 *    기입이 DB에 쌓여 있으면 재시작 후 그냥 다시 더하면 끝난다. 복구 코드가 따로 없다.
 *
 * 2. 되감기가 공짜다. "3번 문제 무효" = 삭제가 아니라 VOID 기입을 하나 더 추가.
 *    원본은 남는다. 무효를 무효로 되돌리는 것도 그냥 또 하나의 기입이다.
 *
 * 3. ★그리고 이게 연출이다★
 *    무효가 기입이면 빔이 "3번 문제 무효!"를 띄우고 점수가 내려가는 게 보인다.
 *    조용히 값만 바꾸면 관객은 숫자가 이유 없이 변한 걸 보고 버그라고 생각한다.
 *    되감기가 하나의 비트가 된다. append-only는 엔지니어링 선택이 아니라 연출 선택이다.
 */

const EntryBase = {
  seq: Seq,
  sessionId: SessionId,
  at: EpochMs,
  by: z.enum(['HOST', 'SYSTEM']),
};

/**
 * 낮 야외 PG 점수. CLAUDE.md 콘솔 필수기능: "낮 야외 PG 점수 수동 입력".
 * ★유일하게 set 의미다★ (나머지는 전부 add). 마지막 SEED만 유효하다.
 *
 * 왜 비대칭이냐: 사회자는 7:58에 낮 점수를 오타 낸다. "보정 기입으로 상쇄하세요"는
 * 8시 정각에 암산을 시키는 것이다. 그냥 다시 입력하면 덮이게 한다.
 */
export const SeedEntry = z.object({
  ...EntryBase,
  kind: z.literal('SEED'),
  totals: z.record(TeamId, z.number().int()),
  note: z.string().optional(),
});
export type SeedEntry = z.infer<typeof SeedEntry>;

/**
 * 라운드 확정 점수. CLAUDE.md: "라운드 확정 점수는 매 라운드 스냅샷 저장."
 * LockReveal은 라운드당 1건, Live는 매치당 1건이 쌓인다.
 *
 * Live가 매치마다 쌓는 게 문서 요구보다 촘촘한데, 이게 오디오 기능이기도 하다 —
 * 탭 줄다리기 12분 동안 점수판이 1번이 아니라 5번 움직인다. "순위 변동이 보여야 야유가 나온다."
 */
export const RoundEntry = z.object({
  ...EntryBase,
  kind: z.literal('ROUND'),
  segmentId: SegmentId,
  roundId: RoundId,
  matchId: MatchId.nullable(), // Live만 non-null
  gameId: GameId,
  /** ★커밋 시점에 동결★. 나중에 토글을 바꿔도 이미 쌓인 기입은 안 변한다. */
  multiplier: z.union([z.literal(1), z.literal(2)]),
  basePoints: z.number().int(),
  /** 게임 모듈이 낸 원본. 배수 적용 전. */
  baseDeltas: z.record(TeamId, z.number().int()),
  /** = baseDeltas × multiplier. 점수 계산은 이것만 본다. */
  appliedDeltas: z.record(TeamId, z.number().int()),
  /** 아카이브 + 리액션용. 개인 단위를 절대 버리지 않는다 — 그게 "OO이 나와봐"의 재료다. */
  detail: z.unknown(),
});
export type RoundEntry = z.infer<typeof RoundEntry>;

/** 점수 수동 보정. CLAUDE.md 콘솔 필수기능. reason이 필수인 건 아카이브가 이야기가 되게 하려고. */
export const AdjustEntry = z.object({
  ...EntryBase,
  kind: z.literal('ADJUST'),
  deltas: z.record(TeamId, z.number().int()),
  reason: z.string().min(1),
});
export type AdjustEntry = z.infer<typeof AdjustEntry>;

/**
 * 되감기. CLAUDE.md 콘솔 필수기능: "라운드 스킵 / 되감기".
 * ROUND | ADJUST 만 대상. VOID의 VOID 금지, SEED VOID 금지(SEED는 그냥 다시 입력).
 */
export const VoidEntry = z.object({
  ...EntryBase,
  kind: z.literal('VOID'),
  voidsSeq: Seq,
  reason: z.string().min(1),
});
export type VoidEntry = z.infer<typeof VoidEntry>;

export const LedgerEntry = z.discriminatedUnion('kind', [
  SeedEntry,
  RoundEntry,
  AdjustEntry,
  VoidEntry,
]);
export type LedgerEntry = z.infer<typeof LedgerEntry>;

/**
 * 점수 계산 규칙 — 이 프로젝트의 채점 모델 전부가 이 3줄이다.
 *
 *   1. SEED   : 마지막 것만 유효 (set)
 *   2. ROUND / ADJUST : 전부 더함 (add)
 *   3. VOID 당한 seq는 건너뜀
 *
 * 배열을 처음부터 훑어서 값 하나로 "접는" 걸 fold라고 한다 (JS의 reduce).
 * 구현은 서버 몫이고, 계약은 규칙만 못박는다:
 *
 *   teamTotal = 낮 PG 시드 + Σ(무효 안 된 라운드 델타) + Σ(무효 안 된 수동 보정)
 *
 * 재시작 복구 = SELECT * FROM session_ledger ORDER BY seq → 위 fold → 끝.
 *
 * ★복구되는 것은 점수뿐이다★. 진행 중이던 라운드는 날아가고 사회자가 다시 제시한다(20초).
 * 세그먼트 커서를 영속화하지 않는 이유: 사회자가 노트북을 손에 들고 서 있다.
 * 어디였는지는 사람이 안다. 값어치 없는 복잡도다.
 */

/** 되감기 UI가 지목할 수 있는 기입인지. */
export const VOIDABLE_KINDS = ['ROUND', 'ADJUST'] as const satisfies readonly LedgerEntry['kind'][];
