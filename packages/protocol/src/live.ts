import { z } from 'zod';
import { EpochMs, MatchId, ParticipantId, TeamId } from './ids.js';

/**
 * Live 게임의 진행 단계. CLAUDE.md 원칙 2:
 * "Live: 연속 입력 스트림 → 빔에 실시간 반영. 리빌 딜레이 없음."
 *
 * LockReveal의 RoundPhase와 별개의 상태 머신이다. 공통 조상을 만들려고 하지 말 것 —
 * 게임 타입이 2개로 고정이라 추상화의 이득이 없고, 억지로 합치면 3번째가 기어들어올 틈이 생긴다.
 */
export const LivePhase = z.enum([
  'IDLE',
  /**
   * 대진 확정, 아직 시작 안 함. "3조 대표 나와!" 하며 사람들이 걸어나오는 구간.
   * ★12분 라운드에서 ACTIVE는 총 2분이고 ARMED가 5분이다★
   * CLAUDE.md가 지목한 "입력 대기 10초"보다 큰 오디오 사망 구간이다.
   * ARM_BED(루프 BGM)를 사회자 멘트 밑에 낮게 깔아야 하는 이유.
   */
  'ARMED',
  'COUNTDOWN',
  /** 탭 수집 + 바 실시간 반영. 밤 전체의 피크. 앱이 도울 게 없다. */
  'ACTIVE',
  /** 결과 확정, 커밋 대기. 사회자가 넘길 때까지 머문다. */
  'ENDED',
]);
export type LivePhase = z.infer<typeof LivePhase>;

export const LEGAL_LIVE_TRANSITIONS: Readonly<Record<LivePhase, readonly LivePhase[]>> = {
  IDLE: ['ARMED'],
  ARMED: ['COUNTDOWN', 'IDLE'],
  COUNTDOWN: ['ACTIVE', 'ARMED'], // ABORT 시 ARMED로 되돌림
  // ★ACTIVE에서 나가는 길은 ENDED뿐이다★ 매치를 중간에 되감을 수 없다 —
  // 잘못된 매치는 outcome VOID로 끝내는 것이지 시간을 되돌리는 게 아니다.
  ACTIVE: ['ENDED'],
  ENDED: ['ARMED', 'IDLE'], // 다음 매치 또는 라운드 종료
} as const;

/**
 * ★앱이 사회자 없이 스스로 하는 Live 전이는 이 둘뿐이다★
 * phase.ts의 AutoTransition과 한 쌍 — 라운드 머신에 2개, 매치 머신에 2개. verify가 둘 다 센다.
 *
 *  - COUNTDOWN_ZERO: "3-2-1-GO"의 GO. 프레임 단위로 정확히 착지해야 한다.
 *  - MATCH_END:      KO(±1000 도달) 또는 시간 종료. ★물리지 판단이 아니다★ —
 *                    바가 끝에 닿았는데 사회자 손을 기다리면 방 전체가 본 승리가 앱에서 지연된다.
 *
 * ARMED → COUNTDOWN(LIVE_START)과 ENDED → 커밋(LIVE_COMMIT)은 사회자다. 원칙 3.
 */
export const LiveAutoTransition = z.enum(['COUNTDOWN_ZERO', 'MATCH_END']);
export type LiveAutoTransition = z.infer<typeof LiveAutoTransition>;

/**
 * 한 매치에서 탭할 수 있는 한쪽 편.
 *
 * ★eligible이 왜 필요한가 — 유연성이 아니라 정합성이다★
 * 이 필드가 없으면 40명 중 아무나 아무 매치에나 탭을 넣을 수 있다. 심심한 5조 애가
 * 1조 vs 4조 결승에 탭을 꽂는다. CLAUDE.md 위험목록 1위가 치팅이다.
 *
 * 그리고 이 필드가 "대표 3명 제한 vs 인원수 정규화" 결정을 통째로 흡수한다:
 *   대표 3명   → eligible.length === 3, norm() === 1
 *   인원수 정규화 → eligible = 조 전원,   norm() === eligible.length
 * 와이어 config는 0개다. 게임 모듈의 norm() 한 줄만 바뀐다.
 *
 * ★이 프로젝트의 결정: 대표 3명 제한★ (단계 0에서 확정)
 * 근거는 성공 기준이다. 전원 탭은 40명이 12분간 조용히 폰만 보는 구간이 된다.
 * 대표 3명은 37명이 소리를 지른다. 정규화가 더 공정하지만 더 조용하고,
 * CLAUDE.md의 기준은 공정성이 아니라 오디오다.
 * 부수 효과로 인바운드가 600 msg/s → ~90 msg/s로 떨어지고 배터리 위험도 줄어든다.
 *
 * ★label·tone이 있었는데 뺐다★ (단계 3 — 첫 소비자가 낸 구멍)
 * 조 이름과 형광색은 점수판이 이미 전 클라이언트에 상시로 준다(session.ts Scoreboard).
 * 여기 또 실으면 콘솔이 라벨을 지어내는 두 번째 진실이 생기고, 둘은 반드시 어긋난다.
 * 빔은 teamId로 점수판에서 이름·색을 찾는다 — 파생이지 중복 전송이 아니다.
 */
export const LiveSide = z.object({
  teamId: TeamId,
  /** 이 매치에서 탭이 유효한 사람들. 여기 없는 사람의 탭은 서버가 조용히 버린다. */
  eligible: z.array(ParticipantId).min(1).readonly(),
});
export type LiveSide = z.infer<typeof LiveSide>;

/**
 * 사회자가 매치를 세팅할 때 보내는 것. 양쪽을 명시적으로 지정한다.
 *
 * ★토너먼트 대진표는 이 계약에 없다★
 * 브래킷을 서버에 넣으면 앱이 "다음은 3조 대 5조입니다"를 결정하게 되는데,
 * 그건 사회자의 일이다(원칙 3). 사회자가 콘솔에서 두 조를 골라서 arm한다.
 * 부전승도, 재경기도, "야 너네 둘이 붙어봐"도 전부 그냥 매치 하나다.
 * 브래킷 로직 0줄로 토너먼트가 되고, 현장에서 계획이 틀어져도 앱이 안 막는다.
 *
 * ★matchId·roundId가 있었는데 뺐다★ (단계 3 — 첫 소비자가 낸 구멍)
 * LIVE_COMMIT 멱등의 키가 matchId인데 그걸 콘솔이 채번하면, 콘솔 새로고침 후
 * "m1"을 다시 쓰는 순간 이미 커밋된 매치와 충돌해 새 매치 점수가 조용히 증발한다.
 * 식별자는 서버가 ARM 때 채번하고 콘솔은 스냅샷에서 읽는다 — 라운드와 같은 규칙이다.
 */
export const LiveArmSpec = z.object({
  a: LiveSide,
  b: LiveSide,
  /** 이 매치에 걸린 점수. 결승만 크게 하고 싶으면 여기서 올린다. ×2 토글은 Live에 없다. */
  basePoints: z.number().int().positive(),
});
export type LiveArmSpec = z.infer<typeof LiveArmSpec>;

/**
 * 확정된 매치의 고정 정보. ARM 때 만들어져 스냅샷(DisplayState LIVE / HostSnapshot.live)에
 * 실린다 — 20Hz 프레임엔 절대 안 실린다. 프레임은 pos 하나만 나른다.
 */
export const MatchCard = z.object({
  matchId: MatchId,
  a: LiveSide,
  b: LiveSide,
  basePoints: z.number().int().positive(),
  /** ACTIVE의 길이. 빔 타이머가 phaseEndsAt과 함께 이걸로 파생된다. 게임 상수의 동결값. */
  durationMs: z.number().int().positive(),
});
export type MatchCard = z.infer<typeof MatchCard>;

/**
 * 탭 줄다리기의 프레임 페이로드.
 *
 * ★필드가 1개뿐인 게 설계다★
 * pos 하나가 바 위치 + 오디오 긴장도 + (원하면) 조명을 전부 굴린다.
 * 바가 KO 선에 가까워질수록 BGM이 조여드는 걸 이벤트 없이 파생할 수 있다 —
 * "지는 쪽이 비명"의 오디오 버전이고, 말 없이 방에 누가 죽어간다는 걸 알린다.
 *
 * ★remainMs가 있었는데 뺐다★ (단계 3 — 첫 소비자가 낸 구멍)
 * ids.ts: "남은 시간(duration)은 절대 보내지 않는다." 프레임은 volatile이라 밀리면
 * 버려지는데, 타이머가 마지막 프레임의 remainMs에 매달리면 프레임이 0.5초 끊길 때
 * 시계가 얼어붙는다. 타이머는 스냅샷의 phaseEndsAt에서 빔이 로컬로 파생한다 —
 * 프레임이 다 죽어도 시계는 간다.
 */
export const TapTugPayload = z.object({
  /** -1000 = a 완승, +1000 = b 완승, 0 = 팽팽. 정수인 건 프레임을 작게 하려고. */
  pos: z.number().int().min(-1000).max(1000),
});
export type TapTugPayload = z.infer<typeof TapTugPayload>;

/**
 * 빔에 20Hz로 나가는 프레임. display room에만 간다. volatile로 보낸다
 * (늦은 프레임은 버린다 — 0.05초 전 바 위치는 쓰레기지 재전송할 데이터가 아니다).
 *
 * 왜 탭마다 안 쏘냐: 대표 3명 × 6조 × 15tap/s 여도 탭당 브로드캐스트는 낭비다.
 * 사람 눈은 20Hz 위를 구분 못 하고, 바는 어차피 CSS 트랜지션으로 보간된다.
 */
export const LiveFrame = z.object({
  matchId: MatchId,
  /** 단조 증가. 순서 뒤바뀐 프레임을 빔이 버리는 근거. */
  seq: z.number().int().nonnegative(),
  serverNow: EpochMs,
  payload: TapTugPayload,
});
export type LiveFrame = z.infer<typeof LiveFrame>;

export const MatchOutcome = z.discriminatedUnion('kind', [
  /** 한쪽이 KO 선(±1000)에 닿음. 압승은 12초에 끝난다 — 짧은 매치 = 매치 수 증가 = 사회자 비트 증가. */
  z.object({ kind: z.literal('KO'), winner: TeamId }),
  /** 시간 종료. 접전이었다는 뜻이라 다른 소리(부저)를 낸다. 다른 소리 = 다른 이야기. */
  z.object({ kind: z.literal('TIMEUP'), winner: TeamId.nullable() }),
  /** 사회자의 ACTIVE 중 ABORT. 커밋 대상이 아니다 — 재경기는 그냥 새로 arm한다. */
  z.object({ kind: z.literal('VOID'), reason: z.string() }),
]);
export type MatchOutcome = z.infer<typeof MatchOutcome>;

/**
 * 바 물리 — 튜닝 값이 아니라 모양만 계약에 남긴다.
 *
 *   pos ∝ (누적 탭 차이). ★중앙으로 돌아가는 감쇠 없음★
 *   감쇠를 넣으면 리드를 유지할 수 없고, 그러면 마지막 5초가 무의미해진다.
 *
 * K(민감도)와 DURATION은 단계 5 리허설에서 실측으로 맞춘다. 와이어로 보내지 않는다 —
 * 현장에서 튜닝할 값이 아니라 리허설에서 확정할 값이다.
 */
export const TAP_TUG_KO_THRESHOLD = 1000;
