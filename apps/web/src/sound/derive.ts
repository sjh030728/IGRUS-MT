import type { DisplayState } from '@mt/protocol';
import { serverNow } from '../socket.js';
import { sound } from './engine.js';

/**
 * ═══ 소리를 상태에서 파생시킨다 ═══
 *
 * display.ts: "구조적인 소리(틱, 스팅, BGM)는 서버가 이벤트로 쏘지 않는다.
 *              빔이 phase + phaseEndsAt에서 스스로 파생한다."
 *
 * ★그래서 이 파일엔 서버 이벤트 구독이 하나도 없다★ 스냅샷만 본다.
 * 진실이 한 줄기라 재접속이 간단하다 — 스냅샷 하나 다시 받으면 소리도 맞는다.
 */

let prevPhase: string | null = null;

/**
 * ★일회성 소리와 지속되는 소리는 규칙이 다르다★
 *
 * - 스팅(잠금/점수)은 **일회성**이라 "방금 그 일이 일어났나"를 봐야 한다.
 *   display.ts 재접속 스팅 억제: "phase가 실제로 바뀌었고 now - phaseStartedAt < 1500 일 때만."
 *   안 그러면 REACTION 중에 빔이 새로고침될 때 리빌 스팅이 다시 터진다.
 *
 * - 틱과 BGM은 **상태**라 그 규칙을 안 쓴다. endsAt에서 스케줄하니까 재접속하면
 *   남은 것만 잡힌다 — 스스로 교정된다. 여기에 억제를 걸면 반대로 재접속 후 무음이 된다.
 */
export function driveSound(state: DisplayState): void {
  const phase = state.mode === 'ROUND' ? state.round.phase : state.mode;

  const changed = phase !== prevPhase;
  if (changed) sound.resetSchedule();

  // BLACK은 패닉 킬이다. 카톡 알림이 빔에 떴는데 BGM이 계속 흐르면 안 된다.
  if (state.mode !== 'ROUND') {
    sound.bedOff();
    prevPhase = phase;
    return;
  }

  const r = state.round;
  // 재접속 스팅 억제 — 이 한 줄이 "새로고침했더니 리빌 스팅이 또 터짐"을 막는다.
  const fresh = serverNow() - r.phaseStartedAt < 1500;
  const key = `${r.roundId}:${r.phase}:${r.phaseEndsAt}`;

  switch (r.phase) {
    case 'COLLECT':
      // ★CLAUDE.md가 지목한 사망 구간. 여기가 비면 안 된다★
      if (r.phaseEndsAt) sound.bedOn(key, r.phaseEndsAt);
      break;

    case 'LOCKED':
      sound.bedOff();
      if (changed && fresh) sound.lockSting();
      break;

    case 'COUNTDOWN':
      sound.bedOff();
      // 틱 + endsAt에 얹히는 리빌 스팅까지 여기서 전부 예약된다.
      // ★리빌 스팅이 REVEAL 도착이 아니라 endsAt에 걸리는 이유★: 서버 지연과 무관하게
      // "0"에 착지시키려고. 프레임이 10ms 늦게 와도 소리는 정시다.
      if (r.phaseEndsAt) sound.countdown(key, r.phaseEndsAt);
      break;

    case 'REACTION':
      sound.bedOff();
      if (changed && fresh) sound.scoreSting();
      break;

    // ★COUNTDOWN → ABORTED 는 합법 전이다★ (phase.ts)
    // 취소 안 하면 "이 문제 무효!" 위로 3초 뒤에 리빌 화음이 터진다.
    case 'ABORTED':
      sound.abortPending();
      break;

    default:
      sound.bedOff();
  }

  prevPhase = phase;
}
