import { useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import type { HostCmd, HostSnapshot } from '@mt/protocol';
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
        </Panel>

        <Panel title={`제출 ${snap.submissions.length}`}>
          <div style={{ maxHeight: 180, overflow: 'auto', fontSize: 13 }}>
            {snap.submissions.map((s, i) => (
              <div key={i} style={{ color: '#aaa' }}>{s.name} · {String(s.value)}{s.revision > 0 && <span style={{ color: TONE.BAD }}> (번복 {s.revision})</span>}</div>
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
              <b>{r.total}{r.lastDelta ? <span style={{ color: TONE.GOOD }}> +{r.lastDelta}</span> : null}</b>
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

const Panel = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div style={{ border: '1px solid #333', borderRadius: 10, padding: 14, background: '#111' }}>
    <div style={{ fontSize: 11, color: '#777', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>{title}</div>
    {children}
  </div>
);

/** ★서버가 내려준 legal로만 끈다. 콘솔이 상태머신을 재구현하지 않는다★ */
const Btn = ({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) => (
  <button
    disabled={!on}
    onClick={onClick}
    style={{
      padding: '10px 14px', borderRadius: 8, fontWeight: 700, fontSize: 13, fontFamily: 'inherit',
      cursor: on ? 'pointer' : 'not-allowed',
      background: on ? '#1c1c1c' : '#0d0d0d',
      color: on ? TONE.NEUTRAL : '#444',
      border: `1px solid ${on ? TONE.NEUTRAL + '66' : '#222'}`,
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
