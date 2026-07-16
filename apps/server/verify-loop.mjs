/**
 * 리빌 루프 검증. `npm run verify -w @mt/server` (서버가 떠 있어야 한다)
 *
 * packages/protocol/verify.ts와 같은 태도다 — 테스트 프레임워크를 안 쓴다.
 * 이건 유닛 테스트가 아니라 ★단계 1 완료 조건이 실제로 도는가★를 확인하는 것이다:
 * "더미 문제 1개로 잠금→카운트다운→동시공개→점수 애니메이션이 돈다."
 *
 * 소리는 빔이 내므로 여기서 못 본다. 대신 소리가 파생되는 근거(phase + phaseEndsAt)가
 * 정확한지를 본다 — display.ts: "빔이 phase + phaseEndsAt에서 스스로 파생한다."
 */
import { io } from 'socket.io-client';

const URL = 'http://localhost:3000';

/**
 * ★하드 타임아웃. 이거 없어서 실제로 당했다★
 * 서버가 안 떠 있으면 socket.io가 조용히 재접속을 무한 시도한다. 그 상태로 이 스크립트가
 * 백그라운드에 남으면, 나중에 띄운 진짜 서버에 ★자동으로 다시 붙어서★ display/play 소켓을
 * 하나씩 차지한다. 그럼 콘솔 health가 "빔 연결됨 · 폰 1대"라고 거짓말한다 —
 * 브라우저를 다 닫아도 안 사라지는 유령이 되어 디버깅을 태운다.
 */
setTimeout(() => {
  console.log('\n타임아웃 — 서버가 떠 있나? (npm start -w @mt/server)');
  process.exit(1);
}, 45_000).unref();
let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? (pass++, console.log('  OK   ' + name)) : (fail++, console.log('  FAIL ' + name)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * ★리스너는 소켓을 만들 때 같이 단다. `await connect()` 뒤에 달면 늦는다★
 * 서버는 handleConnection에서 ★즉시★ 스냅샷을 쏜다(events.gateway.ts). 그 첫 발이
 * 리스너가 붙기 전에 도착해서 조용히 버려지고 있었다 — 그래서 "빔이 붙자마자 뭘 받나"가
 * 여태 한 번도 검사되지 않았다. 7:55에 빔만 켜놓은 구간이 정확히 그것이다.
 */
const connect = (auth, on = {}) => new Promise((res, rej) => {
  const s = io(URL, { transports: ['websocket'], auth, forceNew: true });
  for (const [ev, fn] of Object.entries(on)) s.on(ev, fn);
  s.on('connect', () => res(s));
  s.on('connect_error', rej);
});
const cmd = (host, c) => new Promise((res) => host.emit('host:cmd', c, res));

// 빔이 본 것 전부를 기록한다. 정답 유출과 phase 순서를 여기서 판정한다.
const seen = [];
const playViews = [];

const display = await connect({ role: 'display' }, { 'state:display': (s) => seen.push(s) });
const host = await connect({ role: 'host', token: 'mt-host' });
const phone = await connect({ role: 'play' }, { 'state:play': (s) => playViews.push(s.view) });

const phaseNow = () => { const l = seen[seen.length - 1]?.state; return l?.mode === 'ROUND' ? l.round.phase : l?.mode; };

/**
 * ★차가운 서버를 요구한다. 이거 없이 두 번 돌렸다가 태웠다★
 *
 * 아래 검사는 "전이가 일어났나"가 아니라 ★"지금 이 phase인가"★를 묻는다. 그래서 1회차가
 * 남긴 REACTION에 대고 2회차를 돌리면 `IDLE → PROMPT`는 FAIL인데 `REVEAL → REACTION`은
 * **이미 REACTION이라서 OK가 뜬다** — 아무 일도 안 일어났는데 커밋 지점이 통과했다고 한다.
 * 실측: 14 passed / 12 failed 중 OK 다섯 개가 전부 1회차 잔여물이었다.
 *
 * 시끄럽게 틀리는 건 그나마 낫다. ★잔여 상태가 더 잘 맞으면 전부 초록불★이 뜨면서 아무것도
 * 검증 안 하고, 그게 이 스크립트가 존재하는 이유를 통째로 무효로 만든다.
 * 검사를 전부 "전이 관찰"로 바꾸는 게 정공법이지만, 이 스크립트의 값어치는 짧다는 것이다.
 * 전제를 검사 안 하느니 ★전제를 문 앞에서 막는다★.
 */
await sleep(150);
console.log('\n[0] 빔이 붙자마자 — 7:55, 아직 아무도 아무것도 안 눌렀다');
ok('접속 즉시 스냅샷이 온다 (안 오면 빔이 검은 화면으로 서 있는다)', seen.length > 0);
const cold = seen[seen.length - 1]?.state;
if (!cold) {
  console.log('\n스냅샷이 없어서 나머지를 못 돈다. 서버가 떠 있나? (node dist/main.js)');
  process.exit(1);
}
// 모드가 뭐든 점수판은 항상 실려 있어야 한다. 이건 부팅 직후에도 참이다.
ok('점수판이 처음부터 있다 (CLAUDE.md: "점수판 상시 노출")',
  Array.isArray(cold.scoreboard?.rows) && cold.scoreboard.rows.length >= 2);

// 차가움 = 원장이 비었고 + 라운드가 아직 IDLE. 부팅 때 더미가 적재되므로(app.module.ts)
// 갓 뜬 서버도 mode는 ROUND다 — SCOREBOARD_FULL은 ROUND_NEXT 뒤에나 나온다.
const phase0 = cold.mode === 'ROUND' ? cold.round.phase : null;
const isCold = cold.scoreboard?.throughSeq === 0 &&
  (cold.mode === 'SCOREBOARD_FULL' || phase0 === 'IDLE');
if (!isCold) {
  console.log(`\n★서버가 차갑지 않다★ — mode=${cold.mode}${phase0 ? `/${phase0}` : ''}, throughSeq=${cold.scoreboard?.throughSeq ?? '?'}`);
  console.log('이 스크립트는 빈 원장 + IDLE을 전제한다. 서버를 재시작하고 다시 돌려라.');
  console.log('(제품 버그가 아니다. 이미 REACTION이면 PROMPT로 못 가는 게 전이표가 맞게 도는 것이고,');
  console.log(' 다음 라운드는 ROUND_NEXT로 간다. 이 스크립트가 1회용일 뿐이다.)');
  process.exit(1);
}

console.log('\n[1] 인증 경계 — 폰이 사회자 명령을 쏠 수 있는가 (events.ts: "그 순간 끝이다")');
const forbidden = await new Promise((res) => {
  phone.emit('host:cmd', { c: 'ROUND_SCORE' }, () => res('통과됨'));
  phone.once('error', () => res('거절됨'));
  setTimeout(() => res('무응답'), 500);
});
ok('폰의 host:cmd가 거절된다', forbidden !== '통과됨');

console.log('\n[2] 입장');
const hello = await new Promise((res) => phone.emit('play:hello', { name: '테스터', teamId: 't1' }, res));
ok('play:hello 성공', hello.ok === true);
ok('resumeToken 발급됨 (재접속 근거)', typeof hello.resumeToken === 'string' && hello.resumeToken.length >= 16);

console.log('\n[3] 리빌 루프 — 잠금 → 카운트다운 → 동시공개 → 점수');
await cmd(host, { c: 'ROUND_PRESENT' });
ok('IDLE → PROMPT', phaseNow() === 'PROMPT');

await cmd(host, { c: 'ROUND_OPEN' });
ok('PROMPT → COLLECT', phaseNow() === 'COLLECT');
const endsAt = seen[seen.length - 1].state.round.phaseEndsAt;
ok('COLLECT에 phaseEndsAt이 있다 (빔이 틱 소리를 여기서 파생한다)', typeof endsAt === 'number');

const sub = await new Promise((res) => phone.emit('play:submit', { roundId: 'dummy-r1', value: 'B' }, res));
ok('제출 수락됨', sub.ok === true);

console.log('       ... COLLECT_DEADLINE 대기 (자동 전이 1/2, 사회자 안 누름)');
await sleep(Math.max(0, endsAt - Date.now()) + 400);
ok('★COLLECT → LOCKED 가 저절로 일어났다★', phaseNow() === 'LOCKED');
ok('LOCKED의 phaseEndsAt은 null', seen[seen.length - 1].state.round.phaseEndsAt === null);

await cmd(host, { c: 'ROUND_COUNTDOWN' });
ok('LOCKED → COUNTDOWN (★사회자다. 타이머 아님★ — phase.ts)', phaseNow() === 'COUNTDOWN');
const cdEnds = seen[seen.length - 1].state.round.phaseEndsAt;
ok('COUNTDOWN에 phaseEndsAt이 있다 (3-2-1이 여기서 나온다)', typeof cdEnds === 'number');

console.log('       ... COUNTDOWN_ZERO 대기 (자동 전이 2/2)');
await sleep(Math.max(0, cdEnds - Date.now()) + 400);
ok('★COUNTDOWN → REVEAL 이 저절로 일어났다★', phaseNow() === 'REVEAL');
ok('REVEAL의 phaseEndsAt은 null (리빌 뒤엔 타이머가 없다)', seen[seen.length - 1].state.round.phaseEndsAt === null);
ok('REVEAL에서 deltas는 아직 null (사전 유출 방지)', seen[seen.length - 1].state.round.deltas === null);

const before = seen[seen.length - 1].state.scoreboard.rows.find((r) => r.teamId === 't1').total;
await cmd(host, { c: 'ROUND_SCORE' });
ok('REVEAL → REACTION (★유일한 커밋 지점★)', phaseNow() === 'REACTION');
const after = seen[seen.length - 1].state.scoreboard.rows.find((r) => r.teamId === 't1').total;
ok(`점수가 움직였다 (${before} → ${after})`, after > before);
ok('REACTION에서 deltas가 나온다 (점수 애니메이션의 입력)', seen[seen.length - 1].state.round.deltas !== null);
ok('lastDelta가 채워졌다', seen[seen.length - 1].state.scoreboard.rows.find((r) => r.teamId === 't1').lastDelta > 0);

console.log('\n[4] 빔에 정답이 샜는가 (CLAUDE.md 타협 금지)');
const beam = JSON.stringify(seen);
ok('빔이 본 것 전부에 answerText가 없다', !beam.includes('answerText'));
ok('빔이 본 것 전부에 patter가 없다', !beam.includes('patter'));
const hostState = await new Promise((res) => host.emit('host:hello', { token: 'mt-host' }, res));
ok('콘솔에는 정답이 있다', hostState.state.brief?.answerText?.includes('B'));

console.log('\n[5] 폰이 리빌 순간에 죽는가 (events.ts: "폰이 정답을 띄우면 빔이 장식이 된다")');
ok('폰이 HEADS_UP을 거쳤다', playViews.includes('HEADS_UP'));
ok('폰이 INPUT → HEADS_UP → RESULT 순으로 갔다',
  playViews.indexOf('INPUT') < playViews.indexOf('HEADS_UP') && playViews.indexOf('HEADS_UP') < playViews.lastIndexOf('RESULT'));

console.log('\n[6] 빔 청크 예산 (콘텐츠 ≤3)');
const overBudget = seen.filter((s) => s.state.mode === 'ROUND' && s.state.round.content.length > 3);
ok('예산을 넘긴 프레임이 0개', overBudget.length === 0);

console.log('\n[7] 패닉 킬 (decisions/0002)');
await cmd(host, { c: 'DISPLAY_BLACKOUT', on: true });
ok('빔이 BLACK', phaseNow() === 'BLACK');
await cmd(host, { c: 'DISPLAY_BLACKOUT', on: false });
ok('★끄면 파생이 그대로 돌아온다 (복원할 상태가 없다)★', phaseNow() === 'REACTION');

console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
[display, host, phone].forEach((s) => s.close());
process.exit(fail > 0 ? 1 : 0);
