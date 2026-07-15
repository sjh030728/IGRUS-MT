import { z } from 'zod';

/**
 * LockReveal 라운드의 진행 단계.
 *
 * CLAUDE.md 원칙 1: "잠금 → 카운트다운 → 동시 공개 → 점수 애니메이션. 이 시퀀스가 코어다."
 * 카운트다운이 잠금 "뒤"에 온다는 데 주의. 입력 타이머가 아니라 공개 직전의 두구두구다.
 */
export const RoundPhase = z.enum([
  /** 라운드 적재됨. 빔엔 "문제 4 / 8" + 점수판. 사회자 멘트 구간. */
  'IDLE',
  /** 문제 제시. 폰 입력은 아직 닫혀 있다. 사회자가 문제를 읽는다. 앱은 무음. */
  'PROMPT',
  /** 입력 수집. 마감 타이머 가동. ← CLAUDE.md가 지목한 오디오 사망 구간. */
  'COLLECT',
  /** 잠금. 제출 거부. 채점은 여기서 계산하되 아무한테도 안 보낸다. */
  'LOCKED',
  /** 두구두구. 입력 타이머가 아니다. */
  'COUNTDOWN',
  /** 동시 공개. 한 프레임에 전부. 점수는 아직 안 움직인다. */
  'REVEAL',
  /** 점수 확정 + 사회자 홀드. ★타이머 없음. 사회자가 넘길 때까지 영원히 머문다★ */
  'REACTION',
  /** 커밋 전 무효 처리. 탈출구. */
  'ABORTED',
]);
export type RoundPhase = z.infer<typeof RoundPhase>;

/**
 * ★이 프로젝트에서 제일 중요한 두 줄★
 *
 * 앱이 사회자 없이 스스로 넘어갈 수 있는 전이는 이 둘뿐이다.
 * CLAUDE.md 원칙 3("앱이 사회자를 대체하면 안 된다")과
 * docs/program-ops.md("리액션 시간이 콘텐츠이지 낭비가 아니다")를
 * 주석이 아니라 타입으로 박아둔 것.
 *
 * 나중에 누가 "REACTION 10초 뒤 자동으로 다음 문제" 같은 걸 넣으려 하면
 * 여기에 멤버를 추가해야 하고, 그 순간 이 주석을 읽게 된다.
 *
 *  - COLLECT_DEADLINE: 사회자가 입으로 공지한 룰이다. 앱은 사회자의 스톱워치일 뿐 대체가 아니다.
 *  - COUNTDOWN_ZERO:   "3-2-1" 다음에 프레임 단위로 정확히 착지해야 한다.
 *                      사람이 손으로 치면 드리프트가 생기고 드럼롤이 죽는다.
 */
export const AutoTransition = z.enum(['COLLECT_DEADLINE', 'COUNTDOWN_ZERO']);
export type AutoTransition = z.infer<typeof AutoTransition>;

/**
 * 합법 전이표. 서버가 이걸 보고 명령을 받거나 거절한다.
 * 콘솔은 이 표를 다시 구현하지 않는다 — 서버가 "지금 누를 수 있는 것"을 계산해서 내려준다
 * (HostState.legal). 표가 한 곳에만 살아야 어긋나지 않는다.
 */
export const LEGAL_TRANSITIONS: Readonly<Record<RoundPhase, readonly RoundPhase[]>> = {
  IDLE: ['PROMPT', 'ABORTED'],
  PROMPT: ['COLLECT', 'ABORTED'],
  COLLECT: ['LOCKED', 'ABORTED'],
  LOCKED: ['COUNTDOWN', 'ABORTED'],
  // 카운트다운은 시작하면 반드시 착지한다. 되돌리려면 ABORTED뿐.
  COUNTDOWN: ['REVEAL', 'ABORTED'],
  // REVEAL → REACTION 이 유일한 커밋 지점. 여기서만 점수가 영속화된다.
  REVEAL: ['REACTION', 'ABORTED'],
  // 커밋된 뒤엔 나갈 곳이 없다. 다음 라운드는 새 라운드의 IDLE이다.
  REACTION: [],
  ABORTED: [],
} as const;

/**
 * 명시적으로 만들지 않기로 한 것들 — 나중에 "왜 없지?" 할 때 읽으라고 남긴다.
 *
 * 1. "지금 공개" 버튼 없음.
 *    REVEAL로 들어가는 길은 COUNTDOWN_ZERO 하나뿐이다. 수동 공개 버튼을 만들면
 *    사회자에게 드럼롤을 스킵할 권한을 주는 건데, 드럼롤이 제품이다.
 *    8:40에 시간에 쫓기면 countdownMs를 1000으로 줄여라. 그게 탈출구다.
 *
 * 2. 전원 제출 시 자동 잠금 없음.
 *    4초 만에 40/40이 차도 마감까지 간다. 남은 6초에 사회자가 "3조 아직도 안 냈어!"를
 *    할 수 있는 게 CLAUDE.md가 처방한 사망구간 해법 그 자체다.
 *    앱은 37/40을 빔에 띄우고, 자를지는 사회자가 ROUND_LOCK으로 정한다.
 *    정보는 앱이, 판단은 사람이 — 이게 원칙 3의 작동 형태다.
 *
 * 3. LOCKED → COUNTDOWN 은 사회자다 (타이머 아님).
 *    잠금 스팅 직후 "마감! (아우성) ...자, 갑니다"가 오디오다.
 *    자동으로 두구두구가 깔리면 앱이 사회자 멘트 위를 밟는다.
 */
