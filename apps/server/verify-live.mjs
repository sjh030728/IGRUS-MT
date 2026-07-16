/**
 * 단계 3 완주 검증. `npm run verify:live -w @mt/server` (서버 + Postgres가 떠 있어야 한다)
 *
 * verify-loop.mjs(단계 2)와 같은 태도 — 테스트 프레임워크 없이 ★완료 조건이 실제로 도는가★:
 * "폰 6대 매치 완주, 레이트 상한 동작 확인" — 3 vs 3 실매치를 KO까지 몰고,
 * 치터(콘솔에서 이벤트 뿌리기 — CLAUDE.md 위험 1위)와 비적격 난입을 실제로 시도한다.
 *
 * ★차가운 서버를 요구한다★ (verify-loop와 같은 이유 — throughSeq 0 검사)
 * 원장 비우기: docker compose exec db psql -U mt -d mt -c "DELETE FROM session_ledger;" 후 재시작.
 */
import { io } from 'socket.io-client';

const URL = 'http://localhost:3000';

// 하드 타임아웃 — 유령 소켓 방지 (verify-loop.mjs 머리말 참고)
setTimeout(() => {
  console.log('\n타임아웃 — 서버가 떠 있나? (npm start -w @mt/server, 그 전에 docker compose up -d)');
  process.exit(1);
}, 120_000).unref();

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

// 빔·폰·콘솔이 본 것 전부 — 유출과 phase 흐름을 여기서 판정한다.
const seen = [];          // display 스냅샷
const frames = [];        // display 20Hz 프레임
const hostTicks = [];     // host 2Hz (의심 목록)

const display = await connect({ role: 'display' }, {
  'state:display': (s) => seen.push(s),
  'live:frame': (f) => frames.push(f),
});
const host = await connect({ role: 'host', token: 'mt-host' }, {
  'live:hostTick': (t) => hostTicks.push(t),
});

const last = () => seen[seen.length - 1]?.state;
const hostState = async () => (await ask(host, 'host:hello', { token: 'mt-host' })).state;

await sleep(200);
console.log('\n[0] 부팅 — 차가운 서버 확인');
const cold = last();
if (!cold) { console.log('\n스냅샷이 없다. 서버가 떠 있나?'); process.exit(1); }
if (cold.scoreboard?.throughSeq !== 0) {
  console.log(`\n★서버가 차갑지 않다★ throughSeq=${cold.scoreboard?.throughSeq} — 원장을 비우고 재시작할 것.`);
  process.exit(1);
}
ok('부팅 스냅샷 수신', true);

console.log('\n[1] 입장 — 3 vs 3 대표 + 관전러 1 (완료 조건: 폰 6대)');
const mk = async (name, teamId) => {
  const views = [];
  const s = await connect({ role: 'play' }, { 'state:play': (v) => views.push(v) });
  const h = await ask(s, 'play:hello', { name, teamId });
  return { s, pid: h.participantId, views };
};
// ★views를 다른 배열로 바꿔치기하지 마라 — 리스너는 mk() 안의 원본 배열에 push한다★
const a1 = await mk('김대표', 't1');
const a2 = await mk('이대표', 't1');
const a3 = await mk('박대표', 't1');
const b1 = await mk('최대표', 't2');
const b2 = await mk('정대표', 't2');
const bCheat = await mk('한치터', 't2'); // t2 대표 3번 — 개발자도구를 연다
const spectator = await mk('오관전', 't2'); // 대표 아님 — 난입 시도용
ok('7명 입장', [a1, a2, a3, b1, b2, bCheat, spectator].every((x) => typeof x.pid === 'string'));

console.log('\n[2] Live 세그먼트 진입 — 매치 전엔 점수판 표지');
const gt = await cmd(host, { c: 'SEGMENT_GOTO', segmentId: 'seg-tug' });
await sleep(100);
ok('진입 성공', gt.ok === true);
ok('매치 없음 = SCOREBOARD_FULL 표지 (LIVE 모드는 매치가 있어야 뜬다)', last().mode === 'SCOREBOARD_FULL' && last().title === '탭 줄다리기');

console.log('\n[3] ARM — 서버가 matchId를 채번한다');
const spec = {
  a: { teamId: 't1', eligible: [a1.pid, a2.pid, a3.pid] },
  b: { teamId: 't2', eligible: [b1.pid, b2.pid, bCheat.pid] },
  basePoints: 500,
};
const armR = await cmd(host, { c: 'LIVE_ARM', spec });
await sleep(120);
ok('ARM 수락', armR.ok === true);
const hs1 = await hostState();
ok(`서버 채번 matchId (실제 "${hs1.live?.card.matchId}")`, hs1.live?.card.matchId === 'm1');
ok('콘솔 live — ARMED + 카드', hs1.live?.phase === 'ARMED' && hs1.live.card.basePoints === 500);
ok('빔 LIVE 모드 — 카드 + pos 0', last().mode === 'LIVE' && last().phase === 'ARMED' && last().pos === 0);
ok('대표 폰 = TAP(eligible)', a1.views.at(-1)?.view === 'TAP' && a1.views.at(-1)?.eligible === true);
ok('관전러 폰 = TAP(응원 화면)', spectator.views.at(-1)?.view === 'TAP' && spectator.views.at(-1)?.eligible === false);
const doubleArm = await cmd(host, { c: 'LIVE_ARM', spec });
ok('ARMED 위에 또 ARM은 거절 (먼저 커밋/ABORT)', doubleArm.ok === false);
const earlyCommit = await cmd(host, { c: 'LIVE_COMMIT', matchId: 'm1' });
ok('시작도 안 했는데 커밋 거절 (ENDED에서만)', earlyCommit.ok === false);
const wrongStart = await cmd(host, { c: 'LIVE_START', matchId: 'm999' });
ok('지난/엉뚱한 matchId 명령 거절', wrongStart.ok === false);
const midGoto = await cmd(host, { c: 'SEGMENT_GOTO', segmentId: 'seg-award' });
ok('매치 도는 중 세그먼트 이동 거절 (미커밋 증발 방지)', midGoto.ok === false);

console.log('\n[4] START → 3-2-1 → GO (Live 자동 전이 1/2)');
const startR = await cmd(host, { c: 'LIVE_START', matchId: 'm1' });
await sleep(120);
ok('START 수락 → COUNTDOWN', startR.ok === true && last().mode === 'LIVE' && last().phase === 'COUNTDOWN');
const cdEnds = last().phaseEndsAt;
ok('COUNTDOWN에 phaseEndsAt이 있다 (GO 착지 + 폰 3-2-1의 근거)', typeof cdEnds === 'number');
console.log('       ... GO 대기 (3초. 사회자 안 누름)');
await sleep(Math.max(0, cdEnds - Date.now()) + 300);
ok('★COUNTDOWN → ACTIVE 가 저절로 일어났다★', last().mode === 'LIVE' && last().phase === 'ACTIVE');
ok('ACTIVE에 phaseEndsAt (빔 타이머의 근거 — 프레임이 아니라)', typeof last().phaseEndsAt === 'number');
ok('대표 폰이 TAP(ACTIVE)를 받았다', a1.views.some((v) => v.view === 'TAP' && v.phase === 'ACTIVE'));

console.log('\n[5] 매치 — 정직한 3명 vs 느린 2명 + 치터 1명 + 난입 1명');
// 정직한 t1 대표 3명: 100ms마다 2탭 (offered 20/s — 상한 15/s에 일부 잘린다. 정상이다)
const tappers = [a1, a2, a3].map((p) =>
  setInterval(() => p.s.emit('play:tap', { matchId: 'm1', n: 2, windowMs: 100 }), 100));
// t2 정직 2명: 300ms마다 1탭 (~3.3/s — 지는 쪽)
tappers.push(...[b1, b2].map((p) =>
  setInterval(() => p.s.emit('play:tap', { matchId: 'm1', n: 1, windowMs: 300 }), 300)));
// ★치터★ 50ms마다 50탭 = 1000/s 시도. 레이트 상한이 안 잘라주면 t2가 이겨버린다.
tappers.push(setInterval(() => bCheat.s.emit('play:tap', { matchId: 'm1', n: 50, windowMs: 50 }), 50));
// ★난입★ 비적격 관전러의 탭 — 조용히 버려지고 flag만 남아야 한다
tappers.push(setInterval(() => spectator.s.emit('play:tap', { matchId: 'm1', n: 10, windowMs: 100 }), 100));
// 스키마 밖 조작 — n 상한(100) 초과는 게이트웨이 Zod가 끊는다
bCheat.s.emit('play:tap', { matchId: 'm1', n: 999999, windowMs: 10 });

// ★재접속 리허설★ ACTIVE 한복판에 새 빔이 붙는다 — 스냅샷 1발로 복구되는가 (단계 3 최대 구멍)
await sleep(1200);
const lateDisplay = await connect({ role: 'display' });
const lateHello = await ask(lateDisplay, 'display:hello', {});
ok('★ACTIVE 중 접속한 빔이 스냅샷 1발로 매치를 복구한다★ (카드+phase+pos)',
  lateHello.state.state.mode === 'LIVE' && lateHello.state.state.phase === 'ACTIVE' &&
  lateHello.state.state.card.matchId === 'm1' && typeof lateHello.state.state.pos === 'number');
lateDisplay.close();

console.log('       ... KO 또는 시간 종료 대기');
const t0 = Date.now();
while (Date.now() - t0 < 35_000) {
  if (last()?.mode === 'LIVE' && last().phase === 'ENDED') break;
  await sleep(150);
}
tappers.forEach(clearInterval);

ok('★매치가 스스로 끝났다 (Live 자동 전이 2/2 — KO는 물리다)★', last().mode === 'LIVE' && last().phase === 'ENDED');
const outcome = last().outcome;
ok(`t1 승 — 치터의 1000/s가 상한에 잘려서 정직한 45/s를 못 이긴다 (실제 ${outcome?.kind} ${outcome?.winner})`,
  outcome?.winner === 't1');
ok('프레임이 흘렀다 (20Hz 채널)', frames.length > 20);
ok('프레임 seq 단조 증가', frames.every((f, i) => i === 0 || f.seq > frames[i - 1].seq));
ok('프레임엔 pos뿐 — 남은 시간도 대진도 없다', frames.every((f) => typeof f.payload.pos === 'number' && !('remainMs' in f.payload)));
ok('바가 t1(왼쪽, 음수) 방향으로 움직였다', frames.some((f) => f.payload.pos < -300));
ok('매치 끝 폰 = WAIT (결과는 빔에)', a1.views.at(-1)?.view === 'WAIT');

console.log('\n[6] 안티치트 — 콘솔에만, 조치는 사회자만');
const suspects = hostTicks.flatMap((t) => t.suspects);
const cheatRow = suspects.filter((s) => s.participantId === bCheat.pid).at(-1);
ok(`치터가 의심 목록에 잡혔다 (${cheatRow?.flags.join(',') ?? '없음'})`, Boolean(cheatRow?.flags.includes('PINNED_AT_CAP')));
ok(`치터 통계 — 버림이 인정보다 크다 (인정 ${cheatRow?.stats.credited} / 버림 ${cheatRow?.stats.dropped})`,
  Boolean(cheatRow && cheatRow.stats.dropped > cheatRow.stats.credited));
const intruderRow = suspects.filter((s) => s.participantId === spectator.pid).at(-1);
ok('비적격 난입이 NOT_ELIGIBLE로 잡혔다 (인정 0)', Boolean(intruderRow?.flags.includes('NOT_ELIGIBLE')) && intruderRow?.stats.credited === 0);
ok('★빔이 본 것 전부에 의심 목록이 없다★ (오탐 공개는 그 밤을 끝낸다)',
  !JSON.stringify(seen).includes('flags') && !JSON.stringify(frames).includes('suspects'));
ok('폰이 본 것 전부에 점수판이 없다 (영원히 없다)', !JSON.stringify(a1.views).includes('scoreboard'));

console.log('\n[7] 커밋 — 멱등 + 원장');
const before = (await hostState()).totals;
const c1 = await cmd(host, { c: 'LIVE_COMMIT', matchId: 'm1' });
await sleep(100);
const afterOnce = (await hostState()).totals;
ok(`커밋 — t1 +500 (실제 ${before.t1} → ${afterOnce.t1})`, c1.ok === true && afterOnce.t1 === before.t1 + 500);
const c2 = await cmd(host, { c: 'LIVE_COMMIT', matchId: 'm1' });
await sleep(100);
const afterTwice = (await hostState()).totals;
ok('★두 번 눌러도 점수가 두 번 안 들어간다 (멱등)★', c2.ok === true && afterTwice.t1 === afterOnce.t1);
const entry = (await hostState()).ledgerTail.filter((e) => e.kind === 'ROUND').at(-1);
ok('원장 기입 — matchId 있음 + multiplier 1 (×2는 Live에 없다)', entry?.matchId === 'm1' && entry?.multiplier === 1);
ok('원장 detail에 탭 장부 (개인 단위를 안 버린다 — "OO이 나와봐")',
  Array.isArray(entry?.detail?.taps) && entry.detail.taps.some((t) => t.participantId === bCheat.pid && t.dropped > 0));

console.log('\n[8] 두 번째 매치 — ABORT 경로 (재대진은 그냥 새 매치다)');
const arm2 = await cmd(host, { c: 'LIVE_ARM', spec });
await sleep(100);
const m2 = (await hostState()).live?.card.matchId;
ok(`커밋 뒤 재대진 — 새 matchId (실제 "${m2}")`, arm2.ok === true && m2 === 'm2');
await cmd(host, { c: 'LIVE_START', matchId: 'm2' });
await sleep(3400); // 카운트다운을 넘겨 ACTIVE로
ok('m2 ACTIVE', last().mode === 'LIVE' && last().phase === 'ENDED' === false && last().phase === 'ACTIVE');
const ab = await cmd(host, { c: 'LIVE_ABORT', matchId: 'm2' });
await sleep(100);
ok('ACTIVE 중 ABORT → ENDED(VOID) — 시간을 되감지 않는다', ab.ok === true && last().phase === 'ENDED' && last().outcome?.kind === 'VOID');
const cv = await cmd(host, { c: 'LIVE_COMMIT', matchId: 'm2' });
ok('무효 매치 커밋 거절', cv.ok === false);
const discard = await cmd(host, { c: 'LIVE_ABORT', matchId: 'm2' });
await sleep(100);
ok('ENDED에서 ABORT = 폐기 → 표지로 복귀', discard.ok === true && last().mode === 'SCOREBOARD_FULL');
const totalsEnd = (await hostState()).totals;
ok(`무효 매치는 점수에 흔적이 없다 (t1 ${totalsEnd.t1} · t2 ${totalsEnd.t2 ?? 0})`, totalsEnd.t1 === afterOnce.t1 && (totalsEnd.t2 ?? 0) === (before.t2 ?? 0));
const leave = await cmd(host, { c: 'SEGMENT_GOTO', segmentId: 'seg-award' });
await sleep(100);
ok('매치 정리 후 세그먼트 이동 가능', leave.ok === true && last().mode === 'AWARD');

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
[display, host, a1, a2, a3, b1, b2, bCheat, spectator].forEach((x) => (x.s ?? x).close());
process.exit(fail > 0 ? 1 : 0);
