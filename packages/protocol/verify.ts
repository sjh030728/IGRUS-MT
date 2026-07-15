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
  PlayTap,
  ContentChunks,
  TeamId,
  DisplayState,
  LEGAL_TRANSITIONS,
  AutoTransition,
  VOIDABLE_KINDS,
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

console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
process.exit(fail > 0 ? 1 : 0);
