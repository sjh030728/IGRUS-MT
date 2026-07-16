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

export function Host() {
  const [snap, setSnap] = useState<HostSnapshot | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [points, setPoints] = useState('');
  const [tick, setTick] = useState<{ matchId: string; payload: TapTugPayload; suspects: readonly SuspectRow[] } | null>(null);
  const sockRef = useRef<Socket | null>(null);
  const snapRef = useRef<HostSnapshot | null>(null);
  snapRef.current = snap;

  const send = (c: HostCmd) => {
    sockRef.current?.emit('host:cmd', c, (r: { ok: boolean; message?: string }) => {
      if (!r.ok) setLog((l) => [`✗ ${c.c}: ${r.message}`, ...l].slice(0, 6));
    });
  };

  useEffect(() => {
    const socket = connect({ role: 'host', token: 'mt-host' });
    sockRef.current = socket;
    socket.on('connect', () => socket.emit('host:hello', { token: 'mt-host' }, (r: { ok: boolean; state?: HostSnapshot }) => r.state && setSnap(r.state)));
    socket.on('state:host', (s: HostSnapshot) => setSnap(s));
    // ★의심 목록은 host room에만 온다★ (anticheat.ts) — 2Hz. 빔엔 이 채널이 없다.
    socket.on('live:hostTick', (t: { matchId: string; payload: TapTugPayload; suspects: readonly SuspectRow[] }) => setTick(t));
    return () => { socket.close(); };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = snapRef.current;
      if (!s || s.display.mode !== 'ROUND') return;
      const phase = s.display.round.phase;

      if (e.code === 'Space') {
        e.preventDefault(); // 스페이스가 버튼을 누르거나 스크롤하면 안 된다
        const cmd = SPACE_MAP[phase];
        if (cmd) send({ c: cmd } as HostCmd);
        return;
      }
      // ★다른 손동작★ 리액션은 연타로 못 뚫는다
      if (e.code === 'Enter') { e.preventDefault(); send({ c: 'ROUND_NEXT' }); }
      if (e.code === 'KeyB') send({ c: 'DISPLAY_BLACKOUT', on: true });
      if (e.code === 'KeyN') send({ c: 'DISPLAY_BLACKOUT', on: false });
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

        {log.length > 0 && (
          <Panel title="거절됨">
            {log.map((l, i) => <div key={i} style={{ fontSize: 12, color: TONE.BAD }}>{l}</div>)}
          </Panel>
        )}
      </div>
    </div>
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
