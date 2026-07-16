/**
 * 계약 검증. `npm run verify`
 *
 * 테스트 프레임워크를 안 쓴다 — 이건 게임 로직 테스트가 아니라
 * "CLAUDE.md의 원칙이 진짜로 타입에 박혔는가"를 확인하는 것뿐이다.
 *
 * 이 파일이 존재하는 이유: 나중에 누가 DisplayState에 정답 필드를 추가하거나
 * REACTION에서 나가는 자동 전이를 뚫으려 하면, 리뷰가 아니라 이게 먼저 잡는다.
 */
import {
  HostCmd,
  PlayHello,
  PlayTap,
  PlayPrompt,
  PlaySnapshot,
  ContentChunks,
  TeamId,
  DisplayState,
  LEGAL_TRANSITIONS,
  AutoTransition,
  VOIDABLE_KINDS,
  LEGAL_LIVE_TRANSITIONS,
  LiveAutoTransition,
  LiveArmSpec,
  LiveSide,
  TapTugPayload,
  TAP_TUG_KO_THRESHOLD,
} from './src/index.js';

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean) => {
  if (cond) {
    pass++;
    console.log('  OK   ' + name);
  } else {
    fail++;
    console.log('  FAIL ' + name);
  }
};

console.log('\n[1] 사회자 명령 — 정상 통과 / 조작 거절');
ok('SET_MULTIPLIER m=2 통과', HostCmd.safeParse({ c: 'SET_MULTIPLIER', m: 2 }).success);
ok('SET_MULTIPLIER m=99 거절 (배수는 1|2뿐)', !HostCmd.safeParse({ c: 'SET_MULTIPLIER', m: 99 }).success);
ok('ADJUST reason 없으면 거절 (아카이브가 이야기가 되게)', !HostCmd.safeParse({ c: 'ADJUST', deltas: {} }).success);
ok('없는 명령 거절', !HostCmd.safeParse({ c: 'DELETE_EVERYTHING' }).success);
ok('SET_POINTS 음수 거절', !HostCmd.safeParse({ c: 'SET_POINTS', basePoints: -100 }).success);
ok('DISPLAY_BLACKOUT on=true 통과 (패닉 킬)', HostCmd.safeParse({ c: 'DISPLAY_BLACKOUT', on: true }).success);
ok('DISPLAY_BLACKOUT on=false 통과 — 킬은 왕복이어야 한다', HostCmd.safeParse({ c: 'DISPLAY_BLACKOUT', on: false }).success);
ok('DISPLAY_BLACKOUT on 없으면 거절 (토글 아님 — 두 번 눌러도 같은 결과여야 한다)', !HostCmd.safeParse({ c: 'DISPLAY_BLACKOUT' }).success);
/**
 * ★모드 4개를 전부 도는 게 이 테스트의 요점이다★
 * 원래 버그는 DISPLAY_MODE가 'BLACK' 하나만 받고 나머지 3개를 조용히 거절한 것이었다.
 * 'AWARD' 하나만 찍어보는 테스트였으면 (b)로 고친 지금은 통과하지만, 누가 DISPLAY_MODE를
 * 되살리면서 같은 실수를 반복해도 안 걸린다. 전수로 돌면 "콘솔은 어떤 모드로도 빔을 직접
 * 못 켠다"가 박힌다 — 이게 실제 원칙이다.
 */
ok(
  '콘솔이 빔 모드를 직접 정하는 명령은 없다 — 모드는 세그먼트에서 파생된다',
  DisplayState.options.every((o) => !HostCmd.safeParse({ c: 'DISPLAY_MODE', mode: o.shape.mode.value }).success),
);

console.log('\n[2] 탭 조작 — 개발자도구로 이벤트 뿌리는 시나리오 (CLAUDE.md 위험 1위)');
ok('정상 배치 통과', PlayTap.safeParse({ matchId: 'm1', n: 12, windowMs: 100 }).success);
ok('n=999999 거절 (배치 상한)', !PlayTap.safeParse({ matchId: 'm1', n: 999999, windowMs: 100 }).success);
ok('n=0 거절', !PlayTap.safeParse({ matchId: 'm1', n: 0, windowMs: 100 }).success);
ok('n 소수 거절', !PlayTap.safeParse({ matchId: 'm1', n: 1.5, windowMs: 100 }).success);

console.log('\n[3] 빔 청크 예산 — 콘텐츠 최대 3 (+ 점수판 = 화면 총 4)');
const chunk = { t: 'caption' as const, text: 'x' };
ok('3개 통과', ContentChunks.safeParse([chunk, chunk, chunk]).success);
ok('4개 거절', !ContentChunks.safeParse([chunk, chunk, chunk, chunk]).success);

console.log('\n[4] 원칙이 타입에 박혔는가');
ok('REACTION에서 나가는 전이 0개 — 리액션은 사회자가 끊을 때까지 안 넘어간다', LEGAL_TRANSITIONS.REACTION.length === 0);
ok(
  'REVEAL 진입로는 COUNTDOWN 하나뿐 — "지금 공개" 버튼이 존재할 수 없다',
  Object.entries(LEGAL_TRANSITIONS)
    .filter(([, to]) => to.includes('REVEAL'))
    .map(([from]) => from)
    .join() === 'COUNTDOWN',
);
ok('앱이 스스로 하는 전이는 정확히 2개', AutoTransition.options.length === 2);
ok('SEED는 되감기 대상이 아니다 (다시 입력해서 덮는다)', !(VOIDABLE_KINDS as readonly string[]).includes('SEED'));

console.log('\n[5] 빔에 정답이 갈 수 있는가 (CLAUDE.md: 빔과 콘솔은 절대 같은 화면에 뜨면 안 된다)');
const beam = DisplayState.parse({
  mode: 'ROUND',
  scoreboard: { rows: [], throughSeq: 0 },
  round: {
    phase: 'REVEAL',
    segmentId: 's1',
    roundId: 'r1',
    phaseStartedAt: 1,
    phaseEndsAt: null,
    segmentTitle: '내부 퀴즈',
    index: 1,
    total: 8,
    multiplier: 1,
    content: [],
    deltas: null,
  },
});
ok('빔 payload에 answerText가 없다', !JSON.stringify(beam).includes('answerText'));
ok('REVEAL의 phaseEndsAt은 null — 리빌 뒤엔 타이머가 없다', beam.mode === 'ROUND' && beam.round.phaseEndsAt === null);

console.log('\n[6] 브랜드 타입');
ok('TeamId.parse 통과', TeamId.safeParse('t1').success);
ok('빈 문자열 거절', !TeamId.safeParse('').success);

console.log('\n[7] 폰 입력 어휘 — 문제 본문이 폰으로 갈 수 있는가 (events.ts: 빔을 보게 하려고)');
const choices2 = {
  kind: 'choices' as const,
  items: [
    { value: 'COOP', label: '협력', tone: 'GOOD' as const },
    { value: 'BETRAY', label: '배신', tone: 'BAD' as const },
  ],
};
ok('객관식 2지(배신) 통과', PlayPrompt.safeParse(choices2).success);
ok('1지선다 거절 (고를 게 없다)', !PlayPrompt.safeParse({ ...choices2, items: choices2.items.slice(0, 1) }).success);
ok('7지선다 거절 (엄지 상한 6)', !PlayPrompt.safeParse({ ...choices2, items: Array(7).fill(choices2.items[0]) }).success);
/**
 * ★어휘에 본문 필드가 없다는 걸 실행으로 확인한다★
 * strict가 아니라도 알려지지 않은 kind는 판별 유니온이 거절하고,
 * 어느 멤버에도 자유 텍스트를 실을 자리가 없다 — 실으려면 play.ts에 멤버를 추가해야 하고
 * 그 순간 상단 주석("이름은 빔에 있다")을 읽게 된다.
 */
ok('본문형 프롬프트는 어휘에 없다', !PlayPrompt.safeParse({ kind: 'headline', text: '이 중 마술대회 나간 사람은?' }).success);
const meFixture = { participantId: 'p1', teamId: 't1', name: '김', teamName: '1조', teamColor: 'GREEN' as const };
ok(
  'HEADS_UP엔 scope가 있어야 한다 — "내 답"과 "우리 조 답"은 다른 문구다',
  !PlaySnapshot.safeParse({ view: 'HEADS_UP', me: meFixture, mine: null }).success &&
    PlaySnapshot.safeParse({ view: 'HEADS_UP', me: meFixture, scope: 'TEAM', mine: null }).success,
);

console.log('\n[8] Live 계약 — 탭 줄다리기 (단계 3)');
ok(
  'ACTIVE에서 나가는 길은 ENDED뿐 — 매치는 되감을 수 없다. 무효는 VOID outcome이지 시간여행이 아니다',
  LEGAL_LIVE_TRANSITIONS.ACTIVE.join() === 'ENDED',
);
ok('Live도 앱이 스스로 하는 전이는 정확히 2개 (GO 착지 + 매치 종료 — 물리지 판단이 아니다)', LiveAutoTransition.options.length === 2);
ok(
  'KO 임계 = 페이로드 경계 (±1000이 두 곳에서 어긋나면 바가 끝에 닿기 전에 매치가 끝난다)',
  TAP_TUG_KO_THRESHOLD === 1000 &&
    TapTugPayload.safeParse({ pos: 1000 }).success &&
    !TapTugPayload.safeParse({ pos: 1001 }).success,
);
// non-strict Zod는 모르는 키를 거절이 아니라 ★조용히 벗겨낸다★ — safeParse로 검사하면
// 있는 것처럼 초록불이 뜬다. "필드가 없다"는 shape로 확인해야 한다.
ok('프레임에 남은 시간이 없다 (절대시각 원칙 — 타이머는 스냅샷 phaseEndsAt에서 파생)', !('remainMs' in TapTugPayload.shape));
ok(
  '콘솔은 matchId를 발명할 수 없다 — 서버가 채번한다 (콘솔 새로고침 후 재사용 → 멱등 커밋 충돌 → 점수 증발)',
  !('matchId' in LiveArmSpec.shape) && !('roundId' in LiveArmSpec.shape),
);
ok('대진에 라벨·색이 없다 — 이름과 색은 점수판에서 파생한다 (진실 한 줄기)', !('label' in LiveSide.shape) && !('tone' in LiveSide.shape));
ok(
  'eligible 빈 배열 거절 (아무나 탭 가능한 매치는 매치가 아니다 — 치팅 위험 1위)',
  !LiveSide.safeParse({ teamId: 't1', eligible: [] }).success,
);
// 레이트캡 ★값★은 여기서 못 본다 — 계약은 구조만 굽고(anticheat.ts) 값은 게임 모듈 상수다.
// burst > perSec은 부팅 프리플라이트가, 상한이 실제로 자르는지는 verify-live(E2E 치터)가 본다.
const liveBeam = DisplayState.parse({
  mode: 'LIVE',
  scoreboard: { rows: [], throughSeq: 0 },
  card: {
    matchId: 'm1',
    a: { teamId: 't1', eligible: ['p1', 'p2', 'p3'] },
    b: { teamId: 't2', eligible: ['p4', 'p5', 'p6'] },
    basePoints: 500,
    durationMs: 30000,
  },
  phase: 'ACTIVE',
  phaseStartedAt: 1,
  phaseEndsAt: 2,
  pos: 0,
  outcome: null,
});
ok(
  '빔 LIVE에 의심 목록이 없다 (안티치트는 콘솔 전용 — 오탐을 빔에 띄우면 그 밤이 거기서 끝난다)',
  !JSON.stringify(liveBeam).includes('flags') && !JSON.stringify(liveBeam).includes('dropped'),
);
ok(
  'TAP 뷰엔 phase가 있어야 한다 — 대표가 GO 순간을 폰에서 알아야 첫 1초를 안 잃는다',
  !PlaySnapshot.safeParse({ view: 'TAP', me: meFixture, matchId: 'm1', eligible: true }).success &&
    PlaySnapshot.safeParse({ view: 'TAP', me: meFixture, matchId: 'm1', eligible: true, phase: 'ACTIVE', phaseEndsAt: null }).success,
);

console.log('\n[9] 콘솔 도구 — 파괴적 명령의 안전핀 (단계 4)');
ok('VOID엔 reason이 필수 (아카이브가 이야기가 되게 — ADJUST와 같은 규칙)', !HostCmd.safeParse({ c: 'VOID', seq: 3 }).success && HostCmd.safeParse({ c: 'VOID', seq: 3, reason: '오심' }).success);
ok('VOID seq=0 거절 (Seq는 1부터 — 0을 받으면 "아무것도 안 무효"가 조용히 성공한다)', !HostCmd.safeParse({ c: 'VOID', seq: 0, reason: 'x' }).success);
ok('SEED_SET 정수 강제 (낮 PG에 소수점 점수는 없다)', !HostCmd.safeParse({ c: 'SEED_SET', totals: { t1: 10.5 } }).success);
ok('MUTE는 명시적 boolean (토글이면 두 번 눌렀을 때 원위치 — 패닉 킬과 같은 이유)', !HostCmd.safeParse({ c: 'MUTE_PARTICIPANT', participantId: 'p1' }).success);
ok('SEGMENT_INJECT after 생략 가능 (기본 = 현재 뒤에)', HostCmd.safeParse({ c: 'SEGMENT_INJECT', gameId: 'tap-tug' }).success);
ok('입장 코드(claim) 4자 미만 거절', !PlayHello.safeParse({ claim: 'AB' }).success && PlayHello.safeParse({ claim: 'X7K2' }).success);

console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
process.exit(fail > 0 ? 1 : 0);
