/**
 * 단계 4 완주 검증. `npm run verify:console -w @mt/server` (서버 + Postgres, 차가운 원장)
 *
 * 완료 조건 "콘솔만으로 프로그램 전체 완주"의 실행 검사 — 새 명령 8종
 * (SEED/ADJUST/VOID/SFX/MUTE/ASSIGN/REISSUE/INJECT)과 폰 사망 시나리오(코드 입장),
 * 그리고 재접속-조-리셋 회귀를 민다. 소리 자체는 빔이 내므로 라우팅(누구에게 갔나)만 본다.
 */
import { io } from 'socket.io-client';

const URL = 'http://localhost:3000';
setTimeout(() => { console.log('\n타임아웃 — 서버가 떠 있나?'); process.exit(1); }, 90_000).unref();

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? (pass++, console.log('  OK   ' + name)) : (fail++, console.log('  FAIL ' + name)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const connect = (auth, on = {}) => new Promise((res, rej) => {
  const s = io(URL, { transports: ['websocket'], auth, forceNew: true });
  for (const [ev, fn] of Object.entries(on)) s.on(ev, fn);
  s.on('connect', () => res(s));
  s.on('connect_error', rej);
});
const cmd = (host, c) => new Promise((res) => host.emit('host:cmd', c, res));
const ask = (sock, ev, p) => new Promise((res) => sock.emit(ev, p, res));

const seen = [];
const displaySfx = [];
const phoneSfx = [];

const display = await connect({ role: 'display' }, {
  'state:display': (s) => seen.push(s),
  'sound:sfx': (p) => displaySfx.push(p),
});
const host = await connect({ role: 'host', token: 'mt-host' });
const last = () => seen[seen.length - 1]?.state;
const hostState = async () => (await ask(host, 'host:hello', { token: 'mt-host' })).state;

await sleep(200);
console.log('\n[0] 차가운 서버');
if (!last() || last().scoreboard?.throughSeq !== 0) {
  console.log('원장이 남아 있다 — DELETE FROM session_ledger 후 재시작.');
  process.exit(1);
}
ok('부팅 스냅샷', true);

console.log('\n[1] 입장 + 조 선택 (로비) + 재접속 회귀');
const aViews = [];
const aBye = [];
const pA = await connect({ role: 'play' }, { 'state:play': (v) => aViews.push(v), 'sound:sfx': (p) => phoneSfx.push(p), 'sys:bye': (p) => aBye.push(p) });
const hA0 = await ask(pA, 'play:hello', { name: '김철수' }); // 조 안 고름 — 기본 t1
ok('첫 입장 (기본 조)', hA0.ok === true);
const hA1 = await ask(pA, 'play:hello', { resumeToken: hA0.resumeToken, name: '김철수', teamId: 't2' }); // 로비에서 2조 선택
ok('조 선택 — 같은 신원 유지 + t2', hA1.ok === true && hA1.participantId === hA0.participantId);
const hA2 = await ask(pA, 'play:hello', { resumeToken: hA0.resumeToken, name: '김철수' }); // ★배터리 재접속 — teamId 없이
ok('★재접속이 조를 리셋하지 않는다 (t2 유지)★', hA2.ok === true && (await hostState()).roster.find((r) => r.participantId === hA0.participantId)?.teamId === 't2');

const pB = await connect({ role: 'play' });
const hB = await ask(pB, 'play:hello', { name: '이영희', teamId: 't1' });

console.log('\n[2] 낮 PG 점수 — set 의미 (오타 나면 그냥 다시 입력)');
await cmd(host, { c: 'SEED_SET', totals: { t1: 100, t2: 200, t3: 300, t4: 400 }, note: '오타' });
const s1 = await cmd(host, { c: 'SEED_SET', totals: { t1: 150, t2: 250, t3: 350, t4: 450 }, note: '정정' });
await sleep(80);
const afterSeed = (await hostState()).totals;
ok(`두 번 입력 = 마지막만 유효 (t1=${afterSeed.t1}, 250이 아니라)`, s1.ok === true && afterSeed.t1 === 150 && afterSeed.t4 === 450);

console.log('\n[3] 보정 + 되감기 — 삭제가 아니라 기입');
await cmd(host, { c: 'ADJUST', deltas: { t1: 500 }, reason: '번역 릴레이 1위' });
await sleep(80);
ok(`보정 반영 (t1=${(await hostState()).totals.t1})`, (await hostState()).totals.t1 === 650);
const adjSeq = (await hostState()).ledgerTail.find((e) => e.kind === 'ADJUST')?.seq;
const v1 = await cmd(host, { c: 'VOID', seq: adjSeq, reason: '오심' });
await sleep(80);
ok(`★되감기 — 점수가 돌아온다 (t1=${(await hostState()).totals.t1})★`, v1.ok === true && (await hostState()).totals.t1 === 150);
const v2 = await cmd(host, { c: 'VOID', seq: adjSeq, reason: '또' });
ok('이미 무효인 건 거절 (장부 소음 방지)', v2.ok === false);
const seedSeq = (await hostState()).ledgerTail.find((e) => e.kind === 'SEED')?.seq;
const v3 = await cmd(host, { c: 'VOID', seq: seedSeq, reason: 'x' });
ok('SEED 되감기 거절 (다시 입력해서 덮는 것)', v3.ok === false);
const v4 = await cmd(host, { c: 'VOID', seq: 9999, reason: 'x' });
ok('없는 기입 거절', v4.ok === false);

console.log('\n[4] 무음 — 성공한 척하고 버려진다');
await cmd(host, { c: 'SEGMENT_GOTO', segmentId: 'seg-quiz' });
await cmd(host, { c: 'ROUND_PRESENT' });
await cmd(host, { c: 'ROUND_OPEN' });
await sleep(80);
const rid = last().round.roundId;
await cmd(host, { c: 'MUTE_PARTICIPANT', participantId: hA0.participantId, muted: true });
const mutedSubmit = await ask(pA, 'play:submit', { roundId: rid, value: 'A' });
await sleep(80);
const hs4 = await hostState();
ok('★무음자의 제출이 성공한 척한다 (에러면 다른 폰으로 갈아탄다)★', mutedSubmit.ok === true);
ok('그러나 제출 목록엔 없다', !hs4.submissions.some((s) => s.participantId === hA0.participantId));
ok('미터 분자도 0', last().round.content.find((c) => c.t === 'meter')?.got === 0);
ok('콘솔 로스터에 muted가 보인다', hs4.roster.find((r) => r.participantId === hA0.participantId)?.muted === true);
await cmd(host, { c: 'MUTE_PARTICIPANT', participantId: hA0.participantId, muted: false });
const unmuted = await ask(pA, 'play:submit', { roundId: rid, value: 'A' });
await sleep(80);
ok('해제하면 정상 (사회자만 푼다)', unmuted.ok === true && (await hostState()).submissions.some((s) => s.participantId === hA0.participantId));
await cmd(host, { c: 'ROUND_ABORT', reason: '검증 정리' });

console.log('\n[5] 조 재배정 (콘솔 보정)');
const as1 = await cmd(host, { c: 'ASSIGN_PARTICIPANT', participantId: hB.participantId, teamId: 't3' });
await sleep(80);
ok('이영희 t1 → t3', as1.ok === true && (await hostState()).roster.find((r) => r.participantId === hB.participantId)?.teamId === 't3');
ok('없는 조 거절', (await cmd(host, { c: 'ASSIGN_PARTICIPANT', participantId: hB.participantId, teamId: 't9' })).ok === false);

console.log('\n[6] 폰 사망 → 코드 입장 (위험 3위 실전 경로)');
const re = await cmd(host, { c: 'REISSUE_TOKEN', participantId: hA0.participantId });
const code = re.note?.match(/코드: ([A-Z0-9]{4})/)?.[1];
ok(`발급 — ack.note에 코드가 온다 ("${code}")`, re.ok === true && typeof code === 'string');
// 빌린 폰: 주인(이영희)의 resumeToken이 localStorage에 있다 — claim이 그걸 이겨야 한다.
const borrowed = await connect({ role: 'play' });
const hClaim = await ask(borrowed, 'play:hello', { resumeToken: hB.resumeToken, claim: code, name: '김철수' });
await sleep(80);
ok('★claim이 주인 토큰을 이긴다 — 빌린 폰이 김철수가 된다★', hClaim.ok === true && hClaim.participantId === hA0.participantId);
ok('조도 그대로 (t2)', (await hostState()).roster.find((r) => r.participantId === hA0.participantId)?.teamId === 't2');
ok('죽은 폰이 밀려났다 (sys:bye)', aBye.length === 1);
const reuse = await ask(borrowed, 'play:hello', { claim: code, name: 'x' });
ok('코드는 1회용', reuse.ok === false);
const oldToken = await connect({ role: 'play' });
const hOld = await ask(oldToken, 'play:hello', { resumeToken: hA0.resumeToken, name: '수상한놈' });
ok('옛 토큰은 죽었다 (분실 폰 = 분실 열쇠 — 새 신원이 된다)', hOld.ok === true && hOld.participantId !== hA0.participantId);
oldToken.close();

console.log('\n[7] 사운드보드 — display room에만');
await cmd(host, { c: 'SFX', cue: 'BOO' });
await cmd(host, { c: 'SFX', cue: 'AIRHORN' });
await sleep(150);
ok('빔이 2발 받았다', displaySfx.length === 2 && displaySfx[0].cue === 'BOO');
ok('폰은 0발 (폰에 소리 없음 — 오디오는 방에서 난다)', phoneSfx.length === 0);
ok('없는 큐 거절', (await cmd(host, { c: 'SFX', cue: 'FART' })).ok === false);

console.log('\n[8] 예비 투입 — 프로그램은 추가만 된다');
const before = (await hostState()).program.length;
const inj = await cmd(host, { c: 'SEGMENT_INJECT', gameId: 'tap-tug' });
await sleep(80);
const hs8 = await hostState();
ok('세그먼트가 하나 늘었다', inj.ok === true && hs8.program.length === before + 1);
const injected = hs8.program.find((p) => p.segmentId.startsWith('inj-'));
ok(`현재(퀴즈) 바로 뒤에 꽂혔다 (${injected?.title})`, hs8.program.findIndex((p) => p.segmentId === injected?.segmentId) === hs8.program.findIndex((p) => p.current) + 1);
ok('games 목록이 스냅샷에 있다 (콘솔이 gameId를 타이핑하지 않는다)', hs8.games.some((g) => g.gameId === 'tap-tug'));
ok('없는 게임 거절', (await cmd(host, { c: 'SEGMENT_INJECT', gameId: 'nope' })).ok === false);
const goInj = await cmd(host, { c: 'SEGMENT_GOTO', segmentId: injected.segmentId });
await sleep(80);
ok('투입된 세그먼트로 진입 (탭 줄다리기 표지)', goInj.ok === true && last().mode === 'SCOREBOARD_FULL' && last().title.includes('탭 줄다리기'));

console.log('\n[9] 콘솔만으로 프로그램 전체 순회 (완료 조건의 뼈대)');
let sweep = true;
for (const segId of ['seg-open', 'seg-quiz', 'seg-tug', 'seg-betrayal', 'seg-award']) {
  const r = await cmd(host, { c: 'SEGMENT_GOTO', segmentId: segId });
  if (!r.ok) { sweep = false; console.log(`       ✗ ${segId}: ${r.message}`); break; }
  await sleep(60);
  // 라운드가 자동으로 IDLE에 서므로(quiz/betrayal) 바로 다음 이동이 합법이어야 한다.
}
ok('★처음부터 끝까지 콘솔 명령만으로 이동 가능★', sweep && last().mode === 'AWARD');

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
[display, host, pA, pB, borrowed].forEach((s) => s.close());
process.exit(fail > 0 ? 1 : 0);
