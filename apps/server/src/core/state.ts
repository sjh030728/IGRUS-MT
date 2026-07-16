import type {
  AnswerScope,
  EpochMs,
  GameId,
  LockRevealGame,
  RoundPhase,
  RoundSpec,
  RosterEntry,
  ParticipantId,
  ScoreResult,
  SegmentId,
  SegmentKind,
  SessionId,
  SubmissionRecord,
  TeamInfo,
} from '@mt/protocol';

/**
 * ★실시간 상태는 전부 여기, 메모리에만 산다★
 * CLAUDE.md 원칙 4: "3시간짜리 세션이다. 실시간 상태를 DB에 넣으면 동기화만 느려진다."
 * 영속화되는 건 원장(LedgerService)뿐이고, 그것도 확정 점수만이다.
 *
 * 재시작하면 이 객체는 통째로 날아간다. 그게 맞다 —
 * ledger.ts: "복구되는 것은 점수뿐이다. 진행 중이던 라운드는 날아가고 사회자가 다시 제시한다(20초)."
 */

/** 프로그램의 한 꼭지 정의. session.config.json에서 온다. ★불변★ */
export interface SegmentDef {
  segmentId: SegmentId;
  kind: SegmentKind;
  title: string;
  /** kind가 GAME일 때만 non-null. 부팅 때 레지스트리에 있는지 검사한다. */
  gameId: GameId | null;
}

/**
 * 지금 서 있는 세그먼트. SEGMENT_GOTO가 갈아끼운다.
 *
 * rounds는 진입 때 loadRounds() 1회의 결과다 (game.ts: "문제은행 조회는 여기서 끝낸다").
 * cursor는 rounds에서의 현재 위치. rounds.length면 소진 — 빔은 세그먼트 표지(점수판)로
 * 돌아가고, 사회자 멘트 + SEGMENT_GOTO 구간이 된다.
 */
export interface SegmentState {
  def: SegmentDef;
  /** kind가 GAME이면 그 게임 모듈. 코어가 parseAnswer/score를 여기서 찾는다. */
  game: LockRevealGame<unknown> | null;
  rounds: readonly RoundSpec[];
  cursor: number;
}

/** 진행 중인 라운드 하나. 항상 0개 또는 1개다. */
export interface ActiveRound {
  spec: RoundSpec;
  gameId: GameId;
  /**
   * ★게임한테서 받아 적재 때 동결한다. 코어가 값을 박으면 안 된다★
   * 답이 개인 슬롯에 떨어지나 조 슬롯에 떨어지나 — game.ts: "코어가 아는 전략의 전부다."
   * 이게 빔 미터의 분모(37/40 vs 6/6 조), 폰 스냅샷, 채점 묶음 키를 전부 결정한다.
   */
  scope: AnswerScope;
  phase: RoundPhase;
  phaseStartedAt: EpochMs;
  /** ★COLLECT / COUNTDOWN 에서만 non-null★ — display.ts의 phaseEndsAt 계약 그대로. */
  phaseEndsAt: EpochMs | null;
  /** 라운드 한정. 다음 라운드 진입 시 1로 리셋된다 (events.ts SET_MULTIPLIER 주석). */
  multiplier: 1 | 2;
  /** spec.basePoints의 런타임 오버라이드. SET_POINTS가 IDLE..COLLECT에서만 바꾼다. */
  basePoints: number;
  /** ★전량 보존★ game.ts: "log를 절대 안 버린다" — 리액션에서 지목할 재료다. */
  log: SubmissionRecord<unknown>[];
  /**
   * LOCKED 진입 때 1회 계산해서 얼려둔다.
   * phase.ts: "채점은 여기서 계산하되 아무한테도 안 보낸다."
   */
  scored: ScoreResult | null;
}

export interface SessionState {
  sessionId: SessionId;
  teams: TeamInfo[];
  roster: Map<ParticipantId, RosterEntry>;
  entryOpen: boolean;
  /** 프로그램 전체. 부팅 때 config에서 굽고 그날 안 바뀐다 (예비 투입 SEGMENT_INJECT는 단계 4). */
  program: readonly SegmentDef[];
  /** null은 부팅 직후 찰나뿐 — bootstrap이 첫 세그먼트에 들어가면서 채운다. */
  segment: SegmentState | null;
  round: ActiveRound | null;
  /**
   * ★모드가 아니라 오버라이드다★ decisions/0002 참고.
   * 빔 모드는 세그먼트에서 파생되고, 이 플래그는 그 위에 덮인다.
   */
  blackout: boolean;
  /** 스냅샷마다 증가. 빔이 순서 뒤바뀐 스냅샷을 버리는 근거. */
  stateSeq: number;
}
