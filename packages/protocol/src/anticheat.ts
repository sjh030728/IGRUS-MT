import { z } from 'zod';
import { EpochMs, ParticipantId, TeamId } from './ids.js';

/**
 * 치팅 방어.
 *
 * CLAUDE.md 위험목록 1위:
 * "IT동아리다. 탭 줄다리기에서 콘솔로 이벤트 뿌리는 시도가 반드시 나온다.
 *  서버에서 탭 레이트 상한(인간 한계 ~15tap/s) + 이상치 감지 필수."
 *
 * 반드시 나온다는 게 핵심이다. 누군가 크롬 개발자도구를 열고
 *   setInterval(() => socket.emit('play:tap', { n: 50 }), 10)
 * 을 친다. 이건 가능성이 아니라 예정이다.
 *
 * ★이 파일이 live.ts와 분리된 이유★
 * 안티치트는 엔진 레벨이고, 게임 모듈에서 손이 닿으면 안 된다.
 * 게임은 "인정된 탭 수"만 받는다. 누가 얼마나 버려졌는지는 게임의 관심사가 아니다.
 */

/**
 * 레이트 상한. 서버가 이걸로 자른다.
 *
 * perSec: 지속 상한. 인간의 한계 근처.
 * burst:  순간 허용치. 사람은 진짜로 짧게 20 넘게 친다(두 엄지 교차 연타).
 *         이게 없으면 진짜 잘 치는 사람이 치터로 잡힌다 — 그게 훨씬 나쁘다.
 *
 * 넘친 탭은 "거절"이 아니라 그냥 버린다. 폰에 에러를 띄우면 정상 참가자가
 * 자기가 잘못한 줄 알고 손을 멈춘다. 조용히 상한선까지만 인정한다.
 *
 * ★계약은 구조만 굽는다 — 값(15/25)은 여기 없다★ (concepts/굽기)
 * 값은 게임 모듈 상수다(tap-tug.game.ts의 RATE) — K·DURATION과 함께 리허설이 확정하는
 * 자리라서다. 실측 반영이 계약 수정이 되면 안 되고, config로 빼면 7:30에 사람 손이
 * 닿는다 — 치팅 방어의 상한을 현장에서 만지게 하면 안 된다. burst > perSec 같은
 * 제정신 검사는 부팅 프리플라이트가 한다 (round.service — 7:30에 터뜨린다).
 */
export const RateCap = z.object({
  perSec: z.number().int().positive(),
  burst: z.number().int().positive(),
});
export type RateCap = z.infer<typeof RateCap>;

/** 한 참가자의 매치 중 탭 통계. 메모리에만 산다. */
export const TapStats = z.object({
  participantId: ParticipantId,
  /** 게임에 전달된 수. */
  credited: z.number().int().nonnegative(),
  /** 상한에 걸려 버려진 수. 이게 크면 사람이 아니거나, 우리 상한이 낮은 것이다. */
  dropped: z.number().int().nonnegative(),
  /** 탭 간격의 표준편차(ms). ★사람은 떨린다. 스크립트는 안 떨린다★ */
  intervalStdevMs: z.number().nonnegative(),
  peakPerSec: z.number().int().nonnegative(),
});
export type TapStats = z.infer<typeof TapStats>;

export const AnomalyFlag = z.enum([
  /** 상한에 지속적으로 붙어 있음. 혼자 15.0tap/s를 25초 유지하는 사람은 없다. */
  'PINNED_AT_CAP',
  /** 간격이 너무 규칙적. setInterval의 지문이다. */
  'ROBOTIC_INTERVAL',
  /** eligible이 아닌데 탭을 보냄. 실수일 수도, 아닐 수도. */
  'NOT_ELIGIBLE',
  /** 한 신원으로 두 소켓에서 동시에 탭. 폰 2대 또는 탭 2개. */
  'DUPLICATE_SOCKET',
]);
export type AnomalyFlag = z.infer<typeof AnomalyFlag>;

/**
 * 콘솔에만 뜨는 의심 목록.
 *
 * ★설계에서 제일 중요한 결정: 이건 host room에만 간다★
 *
 *  - 빔에 절대 안 띄운다.
 *  - 앱은 절대 자동으로 실격시키지 않는다.
 *  - 앱은 절대 자동으로 점수를 깎지 않는다.
 *
 * 왜: 공개적으로 누굴 지목하는 건 사회자의 판단이지 앱의 판단이 아니다(원칙 3).
 * 오탐이 한 번만 나도 — 진짜 잘 치는 신입생이 빔에 "치터"로 뜨면 — 그 밤은 거기서 끝난다.
 * 그리고 앱이 조용히 점수를 깎으면 아무도 이유를 모른 채 결과만 이상해진다.
 *
 * 앱이 하는 일: 사회자한테 "3조 김철수, 15.0tap/s 25초 유지, 간격 편차 2ms" 를 보여준다.
 * 사회자가 하는 일: 마이크 잡고 "야 김철수 손 들어봐. 니 지금 뭐 하냐?"
 * ★후자가 압도적으로 재미있고, 그게 성공 기준이다.★
 * 치팅 적발이 콘텐츠가 된다. 앱이 처리하면 그냥 조용한 에러 메시지다.
 *
 * 사회자가 조치하고 싶으면 이미 있는 도구를 쓴다: ADJUST(점수 보정) 또는 MUTE_PARTICIPANT.
 * 안티치트 전용 처벌 경로를 만들지 않는다.
 */
export const SuspectRow = z.object({
  participantId: ParticipantId,
  name: z.string(),
  teamId: TeamId,
  flags: z.array(AnomalyFlag).min(1).readonly(),
  stats: TapStats,
  since: EpochMs,
});
export type SuspectRow = z.infer<typeof SuspectRow>;
