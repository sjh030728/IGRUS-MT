/**
 * 단계 2 완주 검증. `npm run verify -w @mt/server` (서버 + Postgres가 떠 있어야 한다)
 *
 * packages/protocol/verify.ts와 같은 태도다 — 테스트 프레임워크를 안 쓴다.
 * 이건 유닛 테스트가 아니라 ★단계 2 완료 조건이 실제로 도는가★를 확인하는 것이다:
 * "실제 문제로 퀴즈 8문제 + 배신 1라운드 완주" — 퀴즈는 문제은행(DB)에서 적재된 걸
 * 8라운드 전부 돌리고, 배신은 TEAM scope의 전 경로(덮어쓰기·번복·무응답·음수)를 민다.
 *
 * 소리는 빔이 내므로 여기서 못 본다. 대신 소리가 파생되는 근거(phase + phaseEndsAt)가
 * 정확한지를 본다 — display.ts: "빔이 phase + phaseEndsAt에서 스스로 파생한다."
 *
 * ★조기 컷(ROUND_LOCK)을 일부러 많이 쓴다★ 8문제 × 10초를 다 기다리면 2분이 넘고,
 * 조기 컷 자체가 검증 대상이다(사회자의 SPACE). 마감 자동 잠금은 1라운드에서 한 번만 본다.
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
  console.log('\n타임아웃 — 서버가 떠 있나? (npm start -w @mt/server, 그 전에 docker compose up -d)');
  process.exit(1);
}, 150_000).unref();
let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? (pass++, console.log('  OK   ' + name)) : (fail++, console.log('  FAIL ' + name)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * ★리스너는 소켓을 만들 때 같이 단다. `await connect()` 뒤에 달면 늦는다★
 * 서버는 handleConnection에서 ★즉시★ 스냅샷을 쏜다(events.gateway.ts). 그 첫 발이
 * 리스너가 붙기 전에 도착해서 조용히 버려지고 있었다.
 */
const connect = (auth, on = {}) => new Promise((res, rej) => {
  const s = io(URL, { transports: ['websocket'], auth, forceNew: true });
  for (const [ev, fn] of Object.entries(on)) s.on(ev, fn);
  s.on('connect', () => res(s));
  s.on('connect_error', rej);
});
const cmd = (host, c) => new Promise((res) => host.emit('host:cmd', c, res));
const ask = (sock, ev, p) => new Promise((res) => sock.emit(ev, p, res));

// 빔이 본 것 전부 + 폰 하나가 본 것 전부를 기록한다. 유출·phase 순서·예산을 여기서 판정한다.
const seen = [];
const phoneSeen = [];

const display = await connect({ role: 'display' }, { 'state:display': (s) => seen.push(s) });
const host = await connect({ role: 'host', token: 'mt-host' });
const pA = await connect({ role: 'play' }, { 'state:play': (s) => phoneSeen.push(s) }); // 1조 김정답
const pB = await connect({ role: 'play' }); // 1조 이번복 (같은 조 — TEAM 덮어쓰기)
const pC = await connect({ role: 'play' }); // 2조 박오답

const last = () => seen[seen.length - 1]?.state;
const phaseNow = () => { const l = last(); return l?.mode === 'ROUND' ? l.round.phase : l?.mode; };
const roundNow = () => { const l = last(); return l?.mode === 'ROUND' ? l.round : null; };
const hostState = async () => (await ask(host, 'host:hello', { token: 'mt-host' })).state;

/**
 * ★차가운 서버를 요구한다★ 검사가 "전이 관찰"이 아니라 "지금 이 상태인가"라서,
 * 잔여 상태 위에 돌리면 초록불이 거짓말을 한다 (단계 1에서 실측 14/12로 당했다).
 * 단계 2부터 원장이 DB에 남으므로 재실행 전엔 원장을 비워야 한다.
 */
await sleep(200);
console.log('\n[0] 부팅 — 7:55, 아직 아무도 아무것도 안 눌렀다');
ok('접속 즉시 스냅샷이 온다 (안 오면 빔이 검은 화면으로 서 있는다)', seen.length > 0);
const cold = last();
if (!cold) { console.log('\n스냅샷이 없다. 서버가 떠 있나?'); process.exit(1); }
ok('첫 세그먼트 표지 = 낮 점수 현황 (SCOREBOARD_FULL)', cold.mode === 'SCOREBOARD_FULL' && cold.title === '낮 점수 현황');
ok('점수판이 처음부터 있다 (CLAUDE.md: "점수판 상시 노출")',
  Array.isArray(cold.scoreboard?.rows) && cold.scoreboard.rows.length >= 2);
if (cold.scoreboard?.throughSeq !== 0) {
  console.log(`\n★서버가 차갑지 않다★ throughSeq=${cold.scoreboard?.throughSeq} — 원장이 남아 있다.`);
  console.log('원장 비우기: docker compose exec db psql -U mt -d mt -c "DELETE FROM session_ledger;" 후 서버 재시작.');
  console.log('(제품 버그가 아니다 — 재시작 복구가 일하고 있다는 뜻이다. 이 스크립트가 1회용일 뿐이다.)');
  process.exit(1);
}

console.log('\n[1] 인증 경계 — 폰이 사회자 명령을 쏠 수 있는가 (events.ts: "그 순간 끝이다")');
const forbidden = await new Promise((res) => {
  pA.emit('host:cmd', { c: 'ROUND_SCORE' }, () => res('통과됨'));
  pA.once('error', () => res('거절됨'));
  setTimeout(() => res('무응답'), 500);
});
ok('폰의 host:cmd가 거절된다', forbidden !== '통과됨');

console.log('\n[2] 입장');
const hA = await ask(pA, 'play:hello', { name: '김정답', teamId: 't1' });
const hB = await ask(pB, 'play:hello', { name: '이번복', teamId: 't1' });
const hC = await ask(pC, 'play:hello', { name: '박오답', teamId: 't2' });
ok('3명 입장 + resumeToken 발급', hA.ok && hB.ok && hC.ok && hA.resumeToken.length >= 16);

// ─────────────────────────────────────────────────────────────
console.log('\n[3] 퀴즈 — 문제은행에서 8라운드 완주 (단계 2 완료 조건 전반부)');
// ─────────────────────────────────────────────────────────────
const gq = await cmd(host, { c: 'SEGMENT_GOTO', segmentId: 'seg-quiz' });
ok('세그먼트 진입', gq.ok === true);
await sleep(100);
const q1 = roundNow();
ok(`문제은행 적재 — 1/${q1?.total} IDLE (8문제여야 한다)`, q1?.phase === 'IDLE' && q1?.index === 1 && q1?.total === 8);

// 정답은 콘솔 브리프에서 읽는다 — 이 스크립트가 곧 사회자다.
const answerOf = async () => (await hostState()).brief.answerText.split(' ')[0];

let quizDone = 0;
for (let i = 1; i <= 8; i++) {
  const answer = await answerOf();
  await cmd(host, { c: 'ROUND_PRESENT' });
  await cmd(host, { c: 'ROUND_OPEN' });
  await sleep(60);
  const r = roundNow();
  const rid = r.roundId;

  // 폰 답: 김정답은 정답, 박오답은 첫 오답, 이번복은 무제출.
  const wrong = ['A', 'B', 'C', 'D'].find((L) => L !== answer);
  const sA = await ask(pA, 'play:submit', { roundId: rid, value: answer });
  const sC = await ask(pC, 'play:submit', { roundId: rid, value: wrong });

  if (i === 1) {
    ok('제출 수락 (정답·오답)', sA.ok === true && sC.ok === true);
    ok('COLLECT에 phaseEndsAt이 있다 (빔이 틱 소리를 여기서 파생)', typeof r.phaseEndsAt === 'number');
    const meter = r.content.find((c) => c.t === 'meter');
    ok(`미터 분모 = 접속 인원 3 (PARTICIPANT scope · 실제 ${meter?.of})`, meter?.of === 3);
    const badValue = await ask(pA, 'play:submit', { roundId: rid, value: 'Z' });
    ok('보기 밖 값 거절 (parseAnswer 경계)', badValue.ok === false && badValue.reason === 'INVALID');

    // ★마감 자동 잠금(자동 전이 1/2)은 여기서 한 번만 실측한다★
    console.log('       ... COLLECT_DEADLINE 대기 (10초. 자동 전이 1/2 — 사회자 안 누름)');
    await sleep(Math.max(0, r.phaseEndsAt - Date.now()) + 400);
    ok('★COLLECT → LOCKED 가 저절로 일어났다★', phaseNow() === 'LOCKED');
    const late = await ask(pA, 'play:submit', { roundId: rid, value: answer });
    ok('마감 뒤 제출은 PHASE_CLOSED (폰은 "마감됐어요")', late.ok === false && late.reason === 'PHASE_CLOSED');
  } else {
    await cmd(host, { c: 'ROUND_LOCK' }); // 조기 컷 — 사회자의 SPACE
  }

  await cmd(host, { c: 'ROUND_COUNTDOWN' });
  const cd = roundNow().phaseEndsAt;
  if (i === 1) ok('COUNTDOWN에 phaseEndsAt이 있다 (3-2-1이 여기서 나온다)', typeof cd === 'number');
  await sleep(Math.max(0, cd - Date.now()) + 350);
  if (i === 1) {
    ok('★COUNTDOWN → REVEAL 이 저절로 일어났다★ (자동 전이 2/2)', phaseNow() === 'REVEAL');
    ok('REVEAL의 deltas는 아직 null (사전 유출 방지)', roundNow().deltas === null);
    ok('리빌 헤드라인에 정답 이름이 뜬다', roundNow().content.some((c) => c.t === 'headline' && c.text.startsWith('정답:')));
  }
  if (phaseNow() !== 'REVEAL') { ok(`${i}번 REVEAL 도달 실패`, false); break; }

  await cmd(host, { c: 'ROUND_SCORE' });
  await sleep(60);
  if (i === 1) {
    const d = roundNow().deltas;
    ok(`퀴즈 산수 — 정답 1명 조 +100, 오답 조 0 (실제 t1=${d?.t1}, t2=${d?.t2})`, d?.t1 === 100 && d?.t2 === 0);
  }
  if (phaseNow() === 'REACTION') quizDone++;

  await cmd(host, { c: 'ROUND_NEXT' });
  await sleep(60);
}
ok(`★퀴즈 8문제 완주★ (커밋 ${quizDone}/8)`, quizDone === 8);
ok('8문제 뒤는 세그먼트 표지로 (점수판 + 사회자 멘트 구간)', last().mode === 'SCOREBOARD_FULL' && last().title === '동아리 내부 퀴즈');
const afterQuiz = await hostState();
ok(`원장에 ROUND 기입 8건`, afterQuiz.ledgerTail.filter((e) => e.kind === 'ROUND').length >= 8);
ok(`점수판 — 김정답의 1조가 +800 (실제 ${afterQuiz.totals.t1})`, afterQuiz.totals.t1 === 800);

// ─────────────────────────────────────────────────────────────
console.log('\n[4] 배신 라운드 — TEAM scope 전 경로 (단계 2 완료 조건 후반부)');
// ─────────────────────────────────────────────────────────────
const gb = await cmd(host, { c: 'SEGMENT_GOTO', segmentId: 'seg-betrayal' });
ok('세그먼트 진입', gb.ok === true);
await sleep(100);
ok('3라운드 적재, 1라운드 IDLE', roundNow()?.index === 1 && roundNow()?.total === 3);

await cmd(host, { c: 'ROUND_PRESENT' });
await cmd(host, { c: 'ROUND_OPEN' });
await sleep(60);
const bR = roundNow();
ok('미터 분모 = ★조 수 4★ (TEAM scope — 로스터 3명이 아니라)', bR.content.find((c) => c.t === 'meter')?.of === 4);

const midJump = await cmd(host, { c: 'SEGMENT_GOTO', segmentId: 'seg-award' });
ok('★COLLECT 중 세그먼트 이동은 거절된다★ (제출 증발 방지 — 버리려면 ABORT)', midJump.ok === false);

const b1 = await ask(pA, 'play:submit', { roundId: bR.roundId, value: 'COOP' });
const b2 = await ask(pB, 'play:submit', { roundId: bR.roundId, value: 'BETRAY' }); // 같은 조가 덮어씀
const b3 = await ask(pC, 'play:submit', { roundId: bR.roundId, value: 'BETRAY' });
ok('같은 조 덮어쓰기 — ack의 by가 마지막 작성자', b1.ok && b2.ok && b3.ok && b2.by === '이번복');
await sleep(60);
ok('미터 분자 = 제출한 조 수 2 (제출 3건이 아니라)', roundNow().content.find((c) => c.t === 'meter')?.got === 2);
const pAInput = phoneSeen[phoneSeen.length - 1];
ok('폰의 mine = ★우리 조 답★ + 작성자 (내 제출이 아니라)',
  pAInput?.view === 'INPUT' && pAInput.scope === 'TEAM' && pAInput.mine?.value === 'BETRAY' && pAInput.mine?.by === '이번복');

await cmd(host, { c: 'ROUND_LOCK' });
await sleep(60);
const pAHeads = phoneSeen[phoneSeen.length - 1];
ok('HEADS_UP에 scope + 조 답이 ★라벨★로 ("🔪 배신")', pAHeads?.view === 'HEADS_UP' && pAHeads.scope === 'TEAM' && pAHeads.mine === '🔪 배신');

await cmd(host, { c: 'ROUND_COUNTDOWN' });
const bcd = roundNow().phaseEndsAt;
await sleep(Math.max(0, bcd - Date.now()) + 350);
ok('REVEAL 착지', phaseNow() === 'REVEAL');
const bGrid = roundNow().content.find((c) => c.t === 'grid');
ok('★동시 공개 한 프레임★ — 4조 전부 (무응답 2조는 협력으로)', bGrid?.cells.length === 4 && bGrid.cells.filter((c) => c.value === '협력').length === 2);

await cmd(host, { c: 'ROUND_SCORE' });
await sleep(60);
const bd = roundNow().deltas;
ok(`배신 산수 P=300 — 배신 +600·협력 −300 (실제 ${bd?.t1}/${bd?.t2}/${bd?.t3}/${bd?.t4})`,
  bd?.t1 === 600 && bd?.t2 === 600 && bd?.t3 === -300 && bd?.t4 === -300);
const afterB = await hostState();
ok(`점수판에 음수 반영 (t3 = ${afterB.totals.t3})`, afterB.totals.t3 === -300);
const bEntry = afterB.ledgerTail.filter((e) => e.kind === 'ROUND').pop();
const bCall = bEntry?.detail?.callouts?.find((c) => c.teamId === 't1');
ok(`콜아웃 — 마지막 작성자 + 번복 횟수 ("${bCall?.label}")`,
  bCall?.label?.includes('이번복') && bCall?.note?.includes('1번 번복'));

await cmd(host, { c: 'ROUND_NEXT' });
await sleep(60);
ok('2라운드 IDLE + 배점 에스컬레이션 400', roundNow()?.index === 2 && (await hostState()).basePoints === 400);
const jump = await cmd(host, { c: 'ROUND_GOTO', roundId: 'betrayal-r3' });
await sleep(60);
ok('ROUND_GOTO — 3라운드로 점프 (배점 500)', jump.ok === true && roundNow()?.index === 3 && (await hostState()).basePoints === 500);

console.log('\n[5] 유출 — 빔과 폰이 몰라야 하는 것 (CLAUDE.md 타협 금지)');
const beamAll = JSON.stringify(seen);
ok('빔이 본 것 전부에 answerText가 없다', !beamAll.includes('answerText'));
ok('빔이 본 것 전부에 patter가 없다', !beamAll.includes('patter'));
const preReveal = seen.filter((s) => s.state.mode === 'ROUND' && ['IDLE', 'PROMPT', 'COLLECT', 'LOCKED', 'COUNTDOWN'].includes(s.state.round.phase));
ok('공개 전 프레임에 "정답:"이 한 번도 없다', !preReveal.some((s) => JSON.stringify(s).includes('정답:')));
const phoneAll = JSON.stringify(phoneSeen);
ok('폰이 본 것 전부에 문제 본문이 없다 (빔을 보게 하려고)', !phoneAll.includes('사람은?'));
ok('폰이 본 것 전부에 보기 이름이 없다 (이름은 빔에만)', !phoneAll.includes('예시'));
ok('폰이 INPUT → HEADS_UP → RESULT 순으로 갔다', (() => {
  const v = phoneSeen.map((s) => s.view);
  return v.indexOf('INPUT') < v.indexOf('HEADS_UP') && v.indexOf('HEADS_UP') < v.lastIndexOf('RESULT');
})());

console.log('\n[6] 빔 청크 예산 (콘텐츠 ≤3)');
ok('예산을 넘긴 프레임이 0개', seen.filter((s) => s.state.mode === 'ROUND' && s.state.round.content.length > 3).length === 0);

console.log('\n[7] 패닉 킬 (decisions/0002)');
await cmd(host, { c: 'DISPLAY_BLACKOUT', on: true });
ok('빔이 BLACK', phaseNow() === 'BLACK');
await cmd(host, { c: 'DISPLAY_BLACKOUT', on: false });
ok('★끄면 파생이 그대로 돌아온다 (복원할 상태가 없다)★', phaseNow() === 'IDLE');

console.log('\n[8] 시상 — AWARD 세그먼트');
const ga = await cmd(host, { c: 'SEGMENT_GOTO', segmentId: 'seg-award' });
await sleep(60);
ok('AWARD 모드 진입 (IDLE에서 이동 합법)', ga.ok === true && last().mode === 'AWARD');

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
console.log('★원장 영속화는 이 스크립트가 못 본다 — 서버를 재시작해서 점수판이 이어지는지 눈으로 확인할 것★');
console.log(`   (지금 원장 기준 기대값: ${JSON.stringify((await hostState()).totals)})`);
[display, host, pA, pB, pC].forEach((s) => s.close());
process.exit(fail > 0 ? 1 : 0);
