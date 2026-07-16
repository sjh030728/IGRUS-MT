import {
  GameId,
  TAP_TUG_KO_THRESHOLD,
  type LiveArmSpec,
  type LiveGame,
  type MatchOutcome,
  type ParticipantId,
  type RateCap,
  type TapTugPayload,
  type TeamId,
} from '@mt/protocol';

/**
 * ═══ 탭 줄다리기 ═══ 8:19 (라인업 ③), 12분. 밤 전체의 피크.
 *
 * ★게임이 이만큼 작은 게 설계다★ — "엔진이 그 단계의 전부다" (game.ts LiveGame 헤더).
 * 레이트 상한·이상치 감지·프레임 브로드캐스트·상태머신은 전부 엔진(live.service) 소유고,
 * 게임은 인정된 탭을 더해서 바 위치를 내는 누산기다.
 *
 * ★대표 3명 제한 → 정규화 없음★ (live.ts LiveSide 주석 — 단계 0에서 확정)
 * 눌린 탭이 그대로 힘이다. eligible을 조 전원으로 바꾸는 날이 오면 여기 norm 한 줄이 생긴다.
 */

// ── 물리 상수. ★리허설(단계 5)에서 실측으로 확정한다. 와이어로 보내지 않는다★ (live.ts) ──
/** ACTIVE 길이. 12분 세그먼트에 매치 3~4개 + 사회자 비트가 들어가는 크기. */
const DURATION_MS = 30_000;
/**
 * 탭 1개가 바를 미는 양. 대표 3명 × 실효 ~10tap/s 기준, 한쪽이 ~7tap/s 앞설 때
 * KO(1000)까지 ~28초 — 접전은 시간 종료, 압살은 조기 KO가 나는 기울기다.
 */
const K = 5;
/**
 * 레이트 상한. perSec 15 = 인간 지속 한계 근처, burst 25 = 두 엄지 교차 연타의 순간 폭발
 * (anticheat.ts — 진짜 잘 치는 사람이 치터로 잡히는 게 훨씬 나쁘다).
 * ★계약(anticheat.ts)엔 구조만 있고 값은 여기다★ — K·DURATION과 같은 리허설 확정 상수라서.
 * burst > perSec은 부팅 프리플라이트가 검사한다.
 */
const RATE: RateCap = { perSec: 15, burst: 25 };

// 누산기. arm이 초기화하고 accept가 쌓고 tick이 읽는다. 매치는 동시에 하나뿐이다(state.ts).
let sideOf = new Map<ParticipantId, 'a' | 'b'>();
let teamOf: Record<'a' | 'b', TeamId | null> = { a: null, b: null };
let basePoints = 0;
let taps = { a: 0, b: 0 };

export const tapTugGame: LiveGame = {
  gameId: GameId.parse('tap-tug'),
  kind: 'LIVE',
  title: '탭 줄다리기',
  rate: RATE,
  durationMs: DURATION_MS,

  arm(spec: LiveArmSpec): void {
    sideOf = new Map();
    for (const p of spec.a.eligible) sideOf.set(p, 'a');
    for (const p of spec.b.eligible) sideOf.set(p, 'b');
    teamOf = { a: spec.a.teamId, b: spec.b.teamId };
    basePoints = spec.basePoints;
    taps = { a: 0, b: 0 };
  },

  accept(participantId: ParticipantId, credited: number): void {
    const side = sideOf.get(participantId);
    if (side) taps[side] += credited;
  },

  tick(elapsedMs: number): { payload: TapTugPayload; end?: MatchOutcome } {
    // -가 a 쪽 승리 방향, +가 b 쪽 (live.ts TapTugPayload). ★감쇠 없음★ — 리드는 유지된다.
    const raw = (taps.b - taps.a) * K;
    const pos = Math.max(-TAP_TUG_KO_THRESHOLD, Math.min(TAP_TUG_KO_THRESHOLD, raw));
    const payload = { pos };

    if (Math.abs(raw) >= TAP_TUG_KO_THRESHOLD) {
      return { payload, end: { kind: 'KO', winner: (raw < 0 ? teamOf.a : teamOf.b)! } };
    }
    if (elapsedMs >= DURATION_MS) {
      // 정확히 0이면 무승부 — 앱이 동전을 안 던진다. 재경기는 사회자가 새로 arm한다(원칙 3).
      return { payload, end: { kind: 'TIMEUP', winner: pos < 0 ? teamOf.a : pos > 0 ? teamOf.b : null } };
    }
    return { payload };
  },

  settle(outcome: MatchOutcome): ReadonlyMap<TeamId, number> {
    const deltas = new Map<TeamId, number>();
    // 승자만 +P. 패자 감점 없음 — 배신 라운드가 이미 음수 담당이고, 여기는 순수 가산 대결이다.
    if (outcome.kind !== 'VOID' && outcome.winner) deltas.set(outcome.winner, basePoints);
    return deltas;
  },
};
