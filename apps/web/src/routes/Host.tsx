import { useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import type { HostCmd, HostSnapshot, SuspectRow, TapTugPayload } from '@mt/protocol';
import { connect } from '../socket.js';
import { TONE, glow } from '../theme.js';

/**
 * ═══ 사회자 콘솔 ═══
 *
 * ★빔과 절대 같은 화면에 뜨면 안 된다. 여기 정답이 있다★ (CLAUDE.md)
 * 미러링이 아니라 확장 모드 전제다. 리허설에서 이걸 반드시 실측할 것.
 */

/**
 * ★SPACE 하나에 문맥의존으로 매핑한다★ (events.ts)
 * "문제당 5누름 × 8문제. 사회자는 마이크를 들고 있다. 어떤 버튼인지 고르게 하면 안 된다."
 *
 * ★REACTION이 비어 있는 게 핵심이다★
 * "ROUND_NEXT가 SPACE면 안 되는 이유: 문서가 가장 지키라는 전이(리액션 홀드)를
 *  SPACE 연타로 뚫을 수 있게 된다. 유일하게 다른 손동작을 요구해야 한다."
 * 그래서 여기 'REACTION' 키가 없고, 다음 라운드는 Enter다.
 */
const SPACE_MAP: Record<string, HostCmd['c']> = {
  IDLE: 'ROUND_PRESENT',
  PROMPT: 'ROUND_OPEN',
  COLLECT: 'ROUND_LOCK',
  LOCKED: 'ROUND_COUNTDOWN',
  REVEAL: 'ROUND_SCORE',
};

/** 숫자키 1~5 = 사운드보드 (display.ts SfxCue). 마우스로 찾게 하면 안 쓴다. */
const SFX_KEYS = ['DRUMROLL', 'BOO', 'APPLAUSE', 'CRICKETS', 'AIRHORN'] as const;
const SFX_LABEL: Record<(typeof SFX_KEYS)[number], string> = {
  DRUMROLL: '두구두구', BOO: '야유', APPLAUSE: '박수', CRICKETS: '귀뚜라미', AIRHORN: '에어혼',
};

/** 당일엔 /host?token=<config의 hostToken>. 파라미터 없으면 개발 기본값. */
const TOKEN = new URLSearchParams(window.location.search).get('token') ?? 'mt-host';

export function Host() {
  const [snap, setSnap] = useState<HostSnapshot | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [points, setPoints] = useState('');
  const [tick, setTick] = useState<{ matchId: string; payload: TapTugPayload; suspects: readonly SuspectRow[] } | null>(null);
  const sockRef = useRef<Socket | null>(null);
  const snapRef = useRef<HostSnapshot | null>(null);
  snapRef.current = snap;

  const send = (c: HostCmd) => {
    sockRef.current?.emit('host:cmd', c, (r: { ok: boolean; message?: string; note?: string }) => {
      // note = 명령이 사람한테 돌려준 한 줄 (입장 코드 등). 로그가 곧 콘솔의 응답 창이다.
      if (!r.ok) setLog((l) => [`✗ ${c.c}: ${r.message}`, ...l].slice(0, 8));
      else if (r.note) setLog((l) => [`✓ ${r.note}`, ...l].slice(0, 8));
    });
  };

  useEffect(() => {
    const socket = connect({ role: 'host', token: TOKEN });
    sockRef.current = socket;
    socket.on('connect', () => socket.emit('host:hello', { token: TOKEN }, (r: { ok: boolean; state?: HostSnapshot }) => r.state && setSnap(r.state)));
    socket.on('state:host', (s: HostSnapshot) => setSnap(s));
    // ★의심 목록은 host room에만 온다★ (anticheat.ts) — 2Hz. 빔엔 이 채널이 없다.
    socket.on('live:hostTick', (t: { matchId: string; payload: TapTugPayload; suspects: readonly SuspectRow[] }) => setTick(t));
    return () => { socket.close(); };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // ★입력칸에 타이핑 중이면 단축키 전부 무시★ — 배점 입력에 "1"을 치는데
      // 두구두구가 울리면 안 된다. (SET_POINTS 시절부터 있던 잠복 버그 — 스페이스도 샜다.)
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

      const s = snapRef.current;
      if (!s) return;

      // 사운드보드는 phase 무관 — 리액션 8분을 덮는 도구라 아무 때나 울려야 한다.
      const digit = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5'].indexOf(e.code);
      if (digit >= 0) { send({ c: 'SFX', cue: SFX_KEYS[digit]! }); return; }
      if (e.code === 'KeyB') { send({ c: 'DISPLAY_BLACKOUT', on: true }); return; }
      if (e.code === 'KeyN') { send({ c: 'DISPLAY_BLACKOUT', on: false }); return; }

      if (s.display.mode !== 'ROUND') return;
      const phase = s.display.round.phase;

      if (e.code === 'Space') {
        e.preventDefault(); // 스페이스가 버튼을 누르거나 스크롤하면 안 된다
        const cmd = SPACE_MAP[phase];
        if (cmd) send({ c: cmd } as HostCmd);
        return;
      }
      // ★다른 손동작★ 리액션은 연타로 못 뚫는다
      if (e.code === 'Enter') { e.preventDefault(); send({ c: 'ROUND_NEXT' }); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!snap) return <div style={{ color: TONE.NEUTRAL, padding: 24 }}>연결 중…</div>;

  const phase = snap.display.mode === 'ROUND' ? snap.display.round.phase : snap.display.mode;
  const nextSpace = SPACE_MAP[phase];
  const can = (c: string) => snap.legal.includes(c);
  const roundNow = snap.display.mode === 'ROUND' ? snap.display.round : null;

  // 제출 로그에 조 이름을 붙일 표. 점수판이 이미 갖고 있다 — 새 계약 필드가 필요 없다.
  const teamName: Record<string, string> = {};
  if (snap.display.mode !== 'BLACK') for (const r of snap.display.scoreboard.rows) teamName[r.teamId] = r.name;

  return (
    <div style={{ minHeight: '100dvh', background: '#0a0a0a', color: '#ddd', padding: 20, fontFamily: 'ui-monospace, monospace', display: 'grid', gap: 16, gridTemplateColumns: '1fr 320px' }}>
      <div style={{ display: 'grid', gap: 16, alignContent: 'start' }}>
        {/* ★정답. 빔엔 이 필드가 존재조차 안 한다★ */}
        <Panel title="정답 (빔에 없음)">
          {snap.brief ? (
            <>
              <div style={{ fontSize: 34, fontWeight: 800, color: TONE.GOOD, textShadow: glow(TONE.GOOD, 0.6) }}>{snap.brief.answerText}</div>
              {snap.brief.patter && <div style={{ color: '#888', marginTop: 6 }}>💬 {snap.brief.patter}</div>}
            </>
          ) : <span style={{ color: '#666' }}>라운드 없음</span>}
        </Panel>

        <Panel title={`진행 — ${phase}`}>
          <div style={{ fontSize: 22, marginBottom: 10 }}>
            SPACE →{' '}
            <b style={{ color: nextSpace ? TONE.HOT : '#666' }}>
              {nextSpace ?? (phase === 'REACTION' ? 'ENTER (다음 문제)' : '없음')}
            </b>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {(['ROUND_PRESENT', 'ROUND_OPEN', 'ROUND_LOCK', 'ROUND_COUNTDOWN', 'ROUND_SCORE', 'ROUND_NEXT'] as const).map((c) => (
              <Btn key={c} on={can(c)} onClick={() => send({ c } as HostCmd)}>{c.replace('ROUND_', '')}</Btn>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            {/* ★+5초는 없다. 일부러 없다★ (decisions/0002) — 사망 구간을 늘리는 버튼이었다.
                10초가 모자라면 잠그고(SPACE) NO_SUBMIT 콜아웃으로 부른다. */}
            <Btn on={can('SET_MULTIPLIER')} onClick={() => send({ c: 'SET_MULTIPLIER', m: 2 })}>×2 켜기</Btn>
            <Btn on={can('SET_MULTIPLIER')} onClick={() => send({ c: 'SET_MULTIPLIER', m: 1 })}>×1</Btn>
            <Btn on onClick={() => send({ c: 'DISPLAY_BLACKOUT', on: snap.display.mode !== 'BLACK' })}>
              {snap.display.mode === 'BLACK' ? '빔 복구 (N)' : '패닉 킬 (B)'}
            </Btn>
          </div>
          {/* 배점 직접 입력 — 배신 라운드 밴드 튜닝 (events.ts SET_POINTS: IDLE..COLLECT에서만) */}
          <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
            <span style={{ color: '#888', fontSize: 13 }}>배점 {snap.basePoints ?? '—'}</span>
            <input
              value={points}
              onChange={(e) => setPoints(e.target.value)}
              placeholder="새 배점"
              inputMode="numeric"
              style={{ width: 90, padding: '8px 10px', borderRadius: 8, border: '1px solid #333', background: '#000', color: TONE.HOT, fontFamily: 'inherit', fontSize: 13 }}
            />
            <Btn
              on={can('SET_POINTS') && /^[1-9]\d*$/.test(points)}
              onClick={() => { send({ c: 'SET_POINTS', basePoints: Number(points) }); setPoints(''); }}
            >
              적용
            </Btn>
          </div>
        </Panel>

        {/* Live 세그먼트에서만 뜬다 — LIVE_ARM이 legal이거나 매치가 있으면 그 세그먼트다. */}
        {(can('LIVE_ARM') || snap.live) && (
          <LivePanel
            snap={snap}
            tick={tick}
            teamName={teamName}
            can={can}
            send={send}
          />
        )}

        <Panel title="프로그램">
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {snap.program.map((p) => (
              <Btn
                key={p.segmentId}
                on={can('SEGMENT_GOTO') && !p.current}
                hot={p.current}
                onClick={() => send({ c: 'SEGMENT_GOTO', segmentId: p.segmentId })}
              >
                {p.current ? '▶ ' : ''}{p.title}
              </Btn>
            ))}
          </div>
          {snap.segmentRounds.length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
              {snap.segmentRounds.map((r) => (
                <Btn
                  key={r.roundId}
                  on={can('ROUND_GOTO') && roundNow?.roundId !== r.roundId}
                  hot={roundNow?.roundId === r.roundId}
                  onClick={() => send({ c: 'ROUND_GOTO', roundId: r.roundId })}
                >
                  {r.index}
                </Btn>
              ))}
            </div>
          )}
          <InjectRow games={snap.games} can={can('SEGMENT_INJECT')} send={send} />
        </Panel>

        <Panel title={`제출 ${snap.submissions.length}`}>
          <div style={{ maxHeight: 180, overflow: 'auto', fontSize: 13 }}>
            {/* 최신이 위로 — 배신 라운드의 번복 전쟁은 마지막 줄들이 사건이다 */}
            {[...snap.submissions].reverse().map((s, i) => (
              <div key={i} style={{ color: '#aaa' }}>
                <span style={{ color: '#666' }}>{teamName[s.teamId] ?? s.teamId}</span> {s.name} · {String(s.value)}
                {s.revision > 0 && <span style={{ color: TONE.BAD }}> (번복 {s.revision})</span>}
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <div style={{ display: 'grid', gap: 16, alignContent: 'start' }}>
        <Panel title="상태">
          {/* ★빔 브라우저가 죽었으면 리빌을 누르기 전에 알아야 한다★ */}
          <Health ok={snap.health.displayConnected} label="빔 연결" />
          {/* ★7:58에 반드시 문제가 된다★ */}
          <Health ok={snap.health.displayAudioUnlocked} label="빔 사운드" />
          <Health ok={snap.health.db === 'OK'} label="DB 미러" />
          <Health ok label={`폰 ${snap.health.phonesConnected}대`} />
        </Panel>

        <Panel title="점수">
          {snap.display.mode !== 'BLACK' && snap.display.scoreboard.rows.map((r) => (
            <div key={r.teamId} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 15 }}>
              <span>{r.rank}. {r.name}</span>
              {/* 부호를 하드코딩하면 배신 라운드의 음수가 "+-300"이 된다 — 실제로 그랬다 */}
              <b>{r.total}{r.lastDelta ? <span style={{ color: r.lastDelta > 0 ? TONE.GOOD : TONE.BAD }}> {r.lastDelta > 0 ? `+${r.lastDelta}` : r.lastDelta}</span> : null}</b>
            </div>
          ))}
        </Panel>

        {/* 리액션 8분을 덮는 유일한 도구. 숫자키 1~5 (display.ts) */}
        <Panel title="사운드보드 (1~5)">
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {SFX_KEYS.map((cue, i) => (
              <Btn key={cue} on={can('SFX')} onClick={() => send({ c: 'SFX', cue })}>
                {i + 1} {SFX_LABEL[cue]}
              </Btn>
            ))}
          </div>
        </Panel>

        <ScoreToolsPanel teamName={teamName} can={can} send={send} />
        <LedgerPanel tail={snap.ledgerTail} teamName={teamName} can={can('VOID')} send={send} />
        <PeoplePanel roster={snap.roster} teamName={teamName} can={can} send={send} />

        {log.length > 0 && (
          <Panel title="응답">
            {log.map((l, i) => (
              <div key={i} style={{ fontSize: 12, color: l.startsWith('✓') ? TONE.GOOD : TONE.BAD }}>{l}</div>
            ))}
          </Panel>
        )}
      </div>
    </div>
  );
}

/** 예비 게임 즉시 투입 — 현재 세그먼트 뒤에 꽂힌다. 브래킷도 편집도 없다, 추가뿐. */
function InjectRow({ games, can, send }: {
  games: HostSnapshot['games'];
  can: boolean;
  send: (c: HostCmd) => void;
}) {
  const [gameId, setGameId] = useState('');
  const chosen = gameId || games[0]?.gameId || '';
  return (
    <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
      <span style={{ color: '#888', fontSize: 13 }}>예비 투입</span>
      <select value={chosen} onChange={(e) => setGameId(e.target.value)}
        style={{ padding: 6, background: '#000', color: TONE.NEUTRAL, border: '1px solid #333', borderRadius: 6, fontFamily: 'inherit', fontSize: 13 }}>
        {games.map((g) => <option key={g.gameId} value={g.gameId}>{g.title}</option>)}
      </select>
      <Btn on={can && chosen !== ''} onClick={() => send({ c: 'SEGMENT_INJECT', gameId: chosen } as unknown as HostCmd)}>
        현재 뒤에 투입
      </Btn>
    </div>
  );
}

/**
 * 점수 도구 — ★마우스 전용. 파괴적이라 손이 미끄러지면 안 된다★ (events.ts)
 * SEED는 set 의미(오타 나면 그냥 다시 입력), ADJUST는 add + reason 필수.
 */
function ScoreToolsPanel({ teamName, can, send }: {
  teamName: Record<string, string>;
  can: (c: string) => boolean;
  send: (c: HostCmd) => void;
}) {
  const teamIds = Object.keys(teamName);
  const [seed, setSeed] = useState<Record<string, string>>({});
  const [adjTeam, setAdjTeam] = useState('');
  const [adjDelta, setAdjDelta] = useState('');
  const [adjReason, setAdjReason] = useState('');

  const seedReady = teamIds.length > 0 && teamIds.every((t) => /^-?\d+$/.test(seed[t] ?? ''));
  const adjChosen = adjTeam || teamIds[0] || '';
  const adjReady = /^-?[1-9]\d*$/.test(adjDelta) && adjReason.trim().length > 0;

  const inp = { padding: '7px 8px', borderRadius: 6, border: '1px solid #333', background: '#000', color: TONE.HOT, fontFamily: 'inherit', fontSize: 13 } as const;

  return (
    <Panel title="점수 도구">
      {/* 낮 야외 PG — CLAUDE.md 필수기능. 전 조를 한 번에 set한다 */}
      <div style={{ fontSize: 11, color: '#777', marginBottom: 6 }}>낮 PG 점수 (set — 다시 입력하면 덮인다)</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
        {teamIds.map((t) => (
          <label key={t} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, color: '#aaa' }}>
            <span style={{ minWidth: 28 }}>{teamName[t]}</span>
            <input value={seed[t] ?? ''} onChange={(e) => setSeed({ ...seed, [t]: e.target.value })} inputMode="numeric" style={{ ...inp, width: 64 }} />
          </label>
        ))}
      </div>
      <div style={{ marginTop: 8 }}>
        <Btn on={can('SEED_SET') && seedReady} onClick={() => {
          const totals: Record<string, number> = {};
          for (const t of teamIds) totals[t] = Number(seed[t]);
          send({ c: 'SEED_SET', totals, note: '낮 PG 입력' } as unknown as HostCmd);
        }}>
          낮 점수 입력
        </Btn>
      </div>

      {/* 수동 보정 — 번역 릴레이 채점도, 치터 감점도 전부 이것 */}
      <div style={{ fontSize: 11, color: '#777', margin: '12px 0 6px' }}>보정 (add — 이유 필수)</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <select value={adjChosen} onChange={(e) => setAdjTeam(e.target.value)}
          style={{ padding: 6, background: '#000', color: TONE.NEUTRAL, border: '1px solid #333', borderRadius: 6, fontFamily: 'inherit', fontSize: 13 }}>
          {teamIds.map((t) => <option key={t} value={t}>{teamName[t]}</option>)}
        </select>
        <input value={adjDelta} onChange={(e) => setAdjDelta(e.target.value)} placeholder="±점수" inputMode="numeric" style={{ ...inp, width: 64 }} />
        <input value={adjReason} onChange={(e) => setAdjReason(e.target.value)} placeholder="이유 (빔 아카이브에 남음)" style={{ ...inp, width: 170 }} />
        <Btn on={can('ADJUST') && adjReady} onClick={() => {
          send({ c: 'ADJUST', deltas: { [adjChosen]: Number(adjDelta) }, reason: adjReason.trim() } as unknown as HostCmd);
          setAdjDelta(''); setAdjReason('');
        }}>
          보정
        </Btn>
      </div>
    </Panel>
  );
}

/** 원장 꼬리 + 되감기. 삭제가 아니라 VOID 기입 — 빔에 점수가 내려가는 게 보인다 (ledger.ts). */
function LedgerPanel({ tail, teamName, can, send }: {
  tail: HostSnapshot['ledgerTail'];
  teamName: Record<string, string>;
  can: boolean;
  send: (c: HostCmd) => void;
}) {
  if (tail.length === 0) return null;
  const voided = new Set(tail.filter((e) => e.kind === 'VOID').map((e) => e.voidsSeq));

  const label = (e: HostSnapshot['ledgerTail'][number]): string => {
    switch (e.kind) {
      case 'SEED': return `낮 PG set${e.note ? ` — ${e.note}` : ''}`;
      case 'ADJUST': return `보정 ${Object.entries(e.deltas).map(([t, d]) => `${teamName[t] ?? t} ${d > 0 ? '+' : ''}${d}`).join(' ')} — ${e.reason}`;
      case 'VOID': return `#${e.voidsSeq} 무효 — ${e.reason}`;
      case 'ROUND': {
        const sum = Object.entries(e.appliedDeltas).filter(([, d]) => d !== 0).map(([t, d]) => `${teamName[t] ?? t} ${d > 0 ? '+' : ''}${d}`).join(' ');
        return `${e.matchId ? '매치' : '라운드'} ${sum || '±0'}`;
      }
    }
  };

  return (
    <Panel title="원장 (최근 10)">
      {[...tail].reverse().map((e) => (
        <div key={e.seq} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: voided.has(e.seq) ? '#555' : '#aaa', textDecoration: voided.has(e.seq) ? 'line-through' : 'none', marginBottom: 3 }}>
          <span style={{ color: '#666', minWidth: 30 }}>#{e.seq}</span>
          <span style={{ flex: 1 }}>{label(e)}</span>
          {(e.kind === 'ROUND' || e.kind === 'ADJUST') && !voided.has(e.seq) && (
            <button
              disabled={!can}
              onClick={() => {
                // prompt = 의도적 마찰. 되감기는 이유 없이 눌리면 안 된다 (reason 필수는 계약).
                const reason = window.prompt(`#${e.seq}을 무효로 — 이유?`);
                if (reason?.trim()) send({ c: 'VOID', seq: e.seq, reason: reason.trim() });
              }}
              style={{ padding: '2px 8px', borderRadius: 6, fontSize: 11, fontFamily: 'inherit', cursor: can ? 'pointer' : 'not-allowed', background: '#1c0d12', color: TONE.BAD, border: `1px solid ${TONE.BAD}55` }}
            >
              무효
            </button>
          )}
        </div>
      ))}
    </Panel>
  );
}

/**
 * 사람 관리. 배정은 본인이 폰 로비에서 한다 — 여기는 ★보정★이다 (틀린 조, 치터 무음, 폰 사망).
 * 무음은 본인에게 안 보인다 (성공한 척 — session.ts muted). 콘솔에서만 회색으로 보인다.
 */
function PeoplePanel({ roster, teamName, can, send }: {
  roster: HostSnapshot['roster'];
  teamName: Record<string, string>;
  can: (c: string) => boolean;
  send: (c: HostCmd) => void;
}) {
  if (roster.length === 0) return null;
  const teamIds = Object.keys(teamName);
  const sorted = [...roster].sort((a, b) => a.teamId.localeCompare(b.teamId) || a.name.localeCompare(b.name));

  return (
    <Panel title={`사람 ${roster.length}`}>
      <div style={{ maxHeight: 220, overflow: 'auto', display: 'grid', gap: 3 }}>
        {sorted.map((p) => (
          <div key={p.participantId} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
            <span style={{ width: 8, height: 8, borderRadius: 8, background: p.connected ? TONE.GOOD : '#444', flexShrink: 0 }} />
            <span style={{ flex: 1, color: p.muted ? '#555' : '#ccc', textDecoration: p.muted ? 'line-through' : 'none' }}>{p.name}</span>
            <select
              value={p.teamId}
              disabled={!can('ASSIGN_PARTICIPANT')}
              onChange={(e) => send({ c: 'ASSIGN_PARTICIPANT', participantId: p.participantId, teamId: e.target.value } as unknown as HostCmd)}
              style={{ padding: 3, background: '#000', color: TONE.NEUTRAL, border: '1px solid #333', borderRadius: 5, fontFamily: 'inherit', fontSize: 11 }}
            >
              {teamIds.map((t) => <option key={t} value={t}>{teamName[t]}</option>)}
            </select>
            <button
              disabled={!can('MUTE_PARTICIPANT')}
              onClick={() => send({ c: 'MUTE_PARTICIPANT', participantId: p.participantId, muted: !p.muted })}
              title="조용히 무음 — 본인은 모른다"
              style={{ padding: '2px 7px', borderRadius: 5, fontSize: 11, fontFamily: 'inherit', cursor: 'pointer', background: p.muted ? '#1c0d12' : '#111', color: p.muted ? TONE.BAD : '#888', border: '1px solid #333' }}
            >
              {p.muted ? '무음중' : '무음'}
            </button>
            <button
              disabled={!can('REISSUE_TOKEN')}
              onClick={() => send({ c: 'REISSUE_TOKEN', participantId: p.participantId })}
              title="폰 사망 → 빌린 폰으로 재입장할 코드 발급 (응답 패널에 뜸)"
              style={{ padding: '2px 7px', borderRadius: 5, fontSize: 11, fontFamily: 'inherit', cursor: 'pointer', background: '#111', color: '#888', border: '1px solid #333' }}
            >
              코드
            </button>
          </div>
        ))}
      </div>
    </Panel>
  );
}

/**
 * ═══ 탭 줄다리기 콘솔 ═══
 *
 * ★대진은 사회자가 고른다. 브래킷 로직은 서버에 없다★ (live.ts LiveArmSpec)
 * "부전승도, 재경기도, '야 너네 둘이 붙어봐'도 전부 그냥 매치 하나다."
 * matchId는 서버가 채번한다 — 여기선 스냅샷의 matchId를 되돌려줄 뿐이다.
 */
function LivePanel({ snap, tick, teamName, can, send }: {
  snap: HostSnapshot;
  tick: { matchId: string; payload: TapTugPayload; suspects: readonly SuspectRow[] } | null;
  teamName: Record<string, string>;
  can: (c: string) => boolean;
  send: (c: HostCmd) => void;
}) {
  const teamIds = Object.keys(teamName);
  const [teamA, setTeamA] = useState(teamIds[0] ?? '');
  const [teamB, setTeamB] = useState(teamIds[1] ?? '');
  const [repsA, setRepsA] = useState<string[]>([]);
  const [repsB, setRepsB] = useState<string[]>([]);
  const [pts, setPts] = useState('500');

  const m = snap.live;
  const suspects = tick && m && tick.matchId === m.card.matchId ? tick.suspects : [];

  const arm = () =>
    send({
      c: 'LIVE_ARM',
      spec: {
        a: { teamId: teamA, eligible: repsA },
        b: { teamId: teamB, eligible: repsB },
        basePoints: Number(pts),
      },
    } as unknown as HostCmd); // 브랜드 타입은 와이어에서 문자열이다 — 서버 Zod가 다시 도장 찍는다

  return (
    <Panel title={`탭 줄다리기 ${m ? `— ${m.phase}${m.committed ? ' (커밋됨)' : ''}` : ''}`}>
      {/* ── 대진 세팅 (매치 없거나 끝났을 때) ── */}
      {can('LIVE_ARM') && (
        <div style={{ display: 'grid', gap: 10 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <SidePicker label="A (왼쪽)" teams={teamIds} teamName={teamName} team={teamA} setTeam={(t) => { setTeamA(t); setRepsA([]); }} reps={repsA} setReps={setRepsA} roster={snap.roster} />
            <SidePicker label="B (오른쪽)" teams={teamIds} teamName={teamName} team={teamB} setTeam={(t) => { setTeamB(t); setRepsB([]); }} reps={repsB} setReps={setRepsB} roster={snap.roster} />
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ color: '#888', fontSize: 13 }}>걸린 점수</span>
            <input value={pts} onChange={(e) => setPts(e.target.value)} inputMode="numeric"
              style={{ width: 70, padding: '8px 10px', borderRadius: 8, border: '1px solid #333', background: '#000', color: TONE.HOT, fontFamily: 'inherit', fontSize: 13 }} />
            {/* 대표 3명 제한은 규칙이지 계약이 아니다 — 계약은 min 1 (live.ts). 콘솔이 3명을 권장만 한다. */}
            <Btn on={repsA.length > 0 && repsB.length > 0 && teamA !== teamB && /^[1-9]\d*$/.test(pts)} onClick={arm}>
              대진 확정 (ARM)
            </Btn>
            {(repsA.length > 3 || repsB.length > 3) && <span style={{ color: TONE.BAD, fontSize: 12 }}>대표는 3명 권장</span>}
          </div>
        </div>
      )}

      {/* ── 진행 (매치 있을 때) ── */}
      {m && (
        <div style={{ display: 'grid', gap: 8, marginTop: can('LIVE_ARM') ? 12 : 0 }}>
          <div style={{ fontSize: 15 }}>
            <b style={{ color: TONE.NEUTRAL }}>{teamName[m.card.a.teamId] ?? m.card.a.teamId}</b>
            <span style={{ color: '#666' }}> vs </span>
            <b style={{ color: TONE.NEUTRAL }}>{teamName[m.card.b.teamId] ?? m.card.b.teamId}</b>
            <span style={{ color: TONE.HOT }}> · {m.card.basePoints}점</span>
            {tick && tick.matchId === m.card.matchId && m.phase === 'ACTIVE' && (
              <span style={{ color: '#888' }}> · 바 {tick.payload.pos}</span>
            )}
            {m.outcome && (
              <span style={{ color: TONE.GOOD }}>
                {' '}· {m.outcome.kind === 'VOID' ? '무효' : m.outcome.kind === 'KO' ? `KO — ${teamName[m.outcome.winner] ?? ''} 승` : m.outcome.winner ? `타임업 — ${teamName[m.outcome.winner] ?? ''} 승` : '타임업 — 무승부'}
              </span>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Btn on={can('LIVE_START')} onClick={() => send({ c: 'LIVE_START', matchId: m.card.matchId })}>시작 (3-2-1)</Btn>
            {/* ★커밋이 Live의 점수 영속화 지점이다★ 라운드의 ROUND_SCORE와 한 쌍. */}
            <Btn on={can('LIVE_COMMIT')} onClick={() => send({ c: 'LIVE_COMMIT', matchId: m.card.matchId })}>점수 커밋</Btn>
            <Btn on={can('LIVE_ABORT')} onClick={() => send({ c: 'LIVE_ABORT', matchId: m.card.matchId })}>중단/폐기</Btn>
          </div>
        </div>
      )}

      {/* ── 의심 목록 — ★앱은 절대 자동 조치하지 않는다★ (anticheat.ts) ── */}
      {suspects.length > 0 && (
        <div style={{ marginTop: 12, borderTop: '1px solid #333', paddingTop: 8 }}>
          <div style={{ fontSize: 11, color: TONE.BAD, marginBottom: 6 }}>의심 — 마이크로 처리하세요 ("야 손 들어봐"). 조치는 ADJUST/MUTE로.</div>
          {suspects.map((x) => (
            <div key={x.participantId} style={{ fontSize: 12, color: '#aaa' }}>
              <b style={{ color: TONE.BAD }}>{x.name}</b> ({teamName[x.teamId] ?? x.teamId}) · {x.flags.join(', ')} ·
              인정 {x.stats.credited} / 버림 {x.stats.dropped} · 피크 {x.stats.peakPerSec}/s · 간격편차 {x.stats.intervalStdevMs}ms
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

/** 한쪽 편 고르기: 조 하나 + 그 조의 접속자 중 대표들. 로스터가 파생 원천이다 (config가 아니라). */
function SidePicker({ label, teams, teamName, team, setTeam, reps, setReps, roster }: {
  label: string;
  teams: string[];
  teamName: Record<string, string>;
  team: string;
  setTeam: (t: string) => void;
  reps: string[];
  setReps: (r: string[]) => void;
  roster: HostSnapshot['roster'];
}) {
  const members = roster.filter((r) => r.teamId === team);
  return (
    <div style={{ border: '1px solid #222', borderRadius: 8, padding: 10 }}>
      <div style={{ fontSize: 11, color: '#777', marginBottom: 6 }}>{label}</div>
      <select value={team} onChange={(e) => setTeam(e.target.value)}
        style={{ width: '100%', padding: 6, background: '#000', color: TONE.NEUTRAL, border: '1px solid #333', borderRadius: 6, fontFamily: 'inherit', fontSize: 13 }}>
        {teams.map((t) => <option key={t} value={t}>{teamName[t]}</option>)}
      </select>
      <div style={{ maxHeight: 110, overflow: 'auto', marginTop: 6, display: 'grid', gap: 2 }}>
        {members.length === 0 && <span style={{ color: '#555', fontSize: 12 }}>접속한 조원 없음</span>}
        {members.map((p) => (
          <label key={p.participantId} style={{ fontSize: 13, color: p.connected ? '#ccc' : '#555', display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={reps.includes(p.participantId)}
              onChange={(e) => setReps(e.target.checked ? [...reps, p.participantId] : reps.filter((x) => x !== p.participantId))}
            />
            {p.name}{!p.connected && ' (끊김)'}
          </label>
        ))}
      </div>
    </div>
  );
}

const Panel = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div style={{ border: '1px solid #333', borderRadius: 10, padding: 14, background: '#111' }}>
    <div style={{ fontSize: 11, color: '#777', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>{title}</div>
    {children}
  </div>
);

/** ★서버가 내려준 legal로만 끈다. 콘솔이 상태머신을 재구현하지 않는다★ hot = 현재 위치 표시. */
const Btn = ({ on, hot = false, onClick, children }: { on: boolean; hot?: boolean; onClick: () => void; children: React.ReactNode }) => (
  <button
    disabled={!on}
    onClick={onClick}
    style={{
      padding: '10px 14px', borderRadius: 8, fontWeight: 700, fontSize: 13, fontFamily: 'inherit',
      cursor: on ? 'pointer' : 'not-allowed',
      background: on ? '#1c1c1c' : '#0d0d0d',
      color: hot ? TONE.HOT : on ? TONE.NEUTRAL : '#444',
      border: `1px solid ${hot ? TONE.HOT : on ? TONE.NEUTRAL + '66' : '#222'}`,
    }}
  >
    {children}
  </button>
);

const Health = ({ ok, label }: { ok: boolean; label: string }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
    <span style={{ width: 9, height: 9, borderRadius: 9, background: ok ? TONE.GOOD : TONE.BAD, boxShadow: glow(ok ? TONE.GOOD : TONE.BAD, 0.4) }} />
    {label}
  </div>
);
