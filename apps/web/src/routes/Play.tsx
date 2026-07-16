import { useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import type { PlaySnapshot, SubmitAck } from '@mt/protocol';
import { connect, serverNow } from '../socket.js';
import { useServerClock } from '../useServerClock.js';
import { TEAM_COLOR, TONE, glow } from '../theme.js';

/**
 * ═══ 폰 뷰 ═══
 *
 * ★/play에 점수판은 영원히 없다★ (events.ts)
 * "폰에 순위가 있으면 아무도 빔을 안 보고 야유가 안 나온다."
 * 계약이 이걸 타입으로 막는다 — PlaySnapshot 어느 멤버에도 scoreboard가 없다.
 */
export function Play() {
  const [snap, setSnap] = useState<PlaySnapshot | null>(null);
  const [ack, setAck] = useState<string | null>(null);
  const sockRef = useRef<Socket | null>(null);

  useEffect(() => {
    const socket = connect({ role: 'play' });
    sockRef.current = socket;

    socket.on('connect', () => {
      // ★재접속의 전부가 이 한 줄이다★ (ids.ts ResumeToken)
      // "물놀이 후 8시면 20% 이하 속출. 이탈/재접속 처리가 실제로 필요하다."
      const saved = localStorage.getItem('mt:resumeToken') ?? undefined;
      const name = localStorage.getItem('mt:name') ?? prompt('이름?') ?? '익명';
      localStorage.setItem('mt:name', name);

      socket.emit('play:hello', { ...(saved ? { resumeToken: saved } : {}), name }, (r: any) => {
        if (!r.ok) return setAck(r.message);
        localStorage.setItem('mt:resumeToken', r.resumeToken);
        setSnap(r.state);
      });
    });

    socket.on('state:play', (s: PlaySnapshot) => setSnap(s));
    return () => { socket.close(); };
  }, []);

  const submit = (roundId: string, value: unknown) => {
    sockRef.current?.emit('play:submit', { roundId, value }, (r: SubmitAck) => {
      // ★PHASE_CLOSED는 10.05초에 반드시 발생한다★ 스피너 대신 "마감됐어요"를 띄운다.
      setAck(r.ok ? null : r.message);
    });
  };

  if (!snap) return <Wrap><Big color={TONE.NEUTRAL}>연결 중…</Big></Wrap>;

  const teamColor = TEAM_COLOR[snap.me.teamColor];

  switch (snap.view) {
    case 'LOBBY':
      return (
        <Wrap>
          <Small>{snap.me.name}</Small>
          <Big color={teamColor}>{snap.me.teamName}</Big>
          <Small>곧 시작합니다</Small>
        </Wrap>
      );

    case 'WAIT':
      return (
        <Wrap>
          <Big color={teamColor}>{snap.me.teamName}</Big>
          <Small>{snap.message}</Small>
        </Wrap>
      );

    case 'INPUT': {
      // ★계약이 어휘를 보장한다★ (play.ts PlayPrompt) — 캐스팅 없이 그대로 그린다.
      const items = snap.prompt.items;
      const mine = snap.mine?.value;
      const isTeam = snap.scope === 'TEAM';
      const mineLabel = items.find((it) => it.value === mine)?.label ?? String(mine ?? '');
      return (
        <Wrap>
          <Countdown endsAt={snap.endsAt} />
          {/* ★문제 본문이 여기 없다★ 빔을 보게 하려고 어휘가 안 싣는다 (play.ts) */}
          <Small>{isTeam ? '조 대표 답 — 아무나 누르고, 잠기기 전까진 서로 덮어써요' : '화면을 보고 고르세요'}</Small>
          <div style={{ display: 'grid', gap: 12, width: '100%', marginTop: 16 }}>
            {items.map((it) => {
              // 배신 라운드처럼 톤이 있는 보기는 그 색(협력=그린, 배신=핑크), 중립이면 조 색.
              const color = it.tone === 'NEUTRAL' ? teamColor : TONE[it.tone];
              const on = mine === it.value;
              return (
                <button
                  key={it.value}
                  onClick={() => submit(snap.roundId, it.value)}
                  style={{
                    padding: '22px 0', fontSize: 30, fontWeight: 800, borderRadius: 14, cursor: 'pointer',
                    background: on ? color : '#000',
                    color: on ? '#000' : color,
                    border: `3px solid ${color}`,
                    boxShadow: on ? glow(color) : 'none',
                  }}
                >
                  {it.label}
                </button>
              );
            })}
          </div>
          {mine != null && (
            <Small>
              {isTeam
                ? <>우리 조 답: <b>{mineLabel}</b>{snap.mine?.by ? ` — ${snap.mine.by}이(가) 눌렀어요` : ''}</>
                : '제출됨 · 잠금 전까진 바꿀 수 있어요'}
            </Small>
          )}
          {ack && <Small color={TONE.BAD}>{ack}</Small>}
        </Wrap>
      );
    }

    /**
     * ★이 계약에서 제일 중요한 뷰다★ (events.ts)
     * "리빌 순간 폰을 죽인다. 폰이 정답을 띄우면 40명이 고개를 박고 빔이 장식이 된다."
     * 그래서 여기에 정보를 추가하고 싶어지면 참아라. 비어 있는 게 기능이다.
     */
    case 'HEADS_UP':
      return (
        <Wrap>
          <div style={{ fontSize: 64, marginBottom: 12 }}>👀</div>
          <Big color={teamColor}>앞을 보세요</Big>
          {/* mine은 서버가 라벨로 번역해서 준다 — 'BETRAY'가 아니라 '🔪 배신'이 뜬다 */}
          {snap.mine != null && <Small>{snap.scope === 'TEAM' ? '우리 조 답' : '내 답'}: {String(snap.mine)}</Small>}
        </Wrap>
      );

    // 그땐 어차피 고개를 숙인다. "야 나 맞았어"가 오디오다.
    case 'RESULT': {
      const d = snap.teamDelta;
      return (
        <Wrap>
          <Small>{snap.me.teamName}</Small>
          <Big color={d > 0 ? TEAM_COLOR.GREEN : d < 0 ? TEAM_COLOR.PINK : TONE.NEUTRAL}>
            {d > 0 ? `+${d}` : d}
          </Big>
          {/* 배신 라운드에서 음수가 실제로 온다 — "이번엔 없네요"로 뭉개면 폰이 거짓말한다 */}
          <Small>{d > 0 ? '올랐어요' : d < 0 ? '내려갔어요…' : '이번엔 변동 없음'}</Small>
        </Wrap>
      );
    }

    case 'TAP': {
      // ★대표가 아닌 37명에겐 응원 화면이 뷰의 전부다★ 그 37명이 오디오다 (live.ts).
      if (!snap.eligible) {
        return (
          <Wrap>
            <div style={{ fontSize: 64 }}>📣</div>
            <Big color={teamColor}>{snap.me.teamName}</Big>
            <Small>대표 경기! 폰 말고 목청으로 응원하세요</Small>
          </Wrap>
        );
      }
      return (
        <TapPad
          key={snap.matchId} // 매치가 바뀌면 카운터·버퍼가 리셋되도록 통째로 다시 만든다
          matchId={snap.matchId}
          phase={snap.phase}
          endsAt={snap.phaseEndsAt}
          color={teamColor}
          tap={(n) => sockRef.current?.emit('play:tap', { matchId: snap.matchId, n, windowMs: 100 })}
        />
      );
    }
  }
}

/**
 * ═══ 탭 패드 ═══
 *
 * ★탭 1회당 1발이 아니라 100ms 모아서 보낸다★ (events.ts PlayTap)
 * "폰이 개수만 세서 10Hz로 올린다. 배터리(위험 3위)와 대역폭 둘 다에 필요하다."
 * 서버는 이 수를 그대로 믿지 않는다 — 레이트 상한이 서버에 있다.
 */
function TapPad({ matchId, phase, endsAt, color, tap }: {
  matchId: string;
  phase: string;
  endsAt: number | null;
  color: string;
  tap: (n: number) => void;
}) {
  const buf = useRef(0);
  const [count, setCount] = useState(0);
  const active = phase === 'ACTIVE';

  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      if (buf.current > 0) {
        tap(buf.current);
        buf.current = 0;
      }
    }, 100);
    return () => clearInterval(t);
    // matchId가 바뀌면 key로 컴포넌트가 통째로 재생성된다 — 여기선 active만 본다.
  }, [active, matchId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (phase === 'ARMED') {
    return (
      <Wrap>
        <Big color={color}>준비!</Big>
        <Small>곧 시작합니다 — 엄지 풀어두세요</Small>
      </Wrap>
    );
  }

  if (phase === 'COUNTDOWN') {
    return (
      <Wrap>
        {endsAt !== null && <Countdown endsAt={endsAt} />}
        <Big color={color}>곧 GO!</Big>
      </Wrap>
    );
  }

  // ACTIVE — 화면 전체가 버튼이다. 마감 10초에 작은 버튼을 조준하게 하면 안 된다.
  return (
    <button
      onPointerDown={(e) => {
        e.preventDefault(); // 더블탭 줌·롱프레스 선택 방지
        buf.current++;
        setCount((c) => c + 1);
      }}
      style={{
        width: '100%', minHeight: '100dvh', background: '#000', border: 'none', cursor: 'pointer',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12,
        WebkitUserSelect: 'none', userSelect: 'none', touchAction: 'manipulation',
      }}
    >
      <div style={{ fontSize: 96, fontWeight: 900, color, textShadow: glow(color, 2), fontVariantNumeric: 'tabular-nums' }}>
        {count}
      </div>
      <div style={{ fontSize: 34, fontWeight: 900, color, textShadow: glow(color) }}>연타!!</div>
      <Small>화면 아무 데나 두드리세요</Small>
    </button>
  );
}

function Countdown({ endsAt }: { endsAt: number }) {
  useServerClock();
  const remain = Math.max(0, endsAt - serverNow());
  const secs = Math.ceil(remain / 1000);
  const color = remain < 3000 ? TONE.BAD : TONE.HOT;
  return (
    <div style={{ fontSize: 56, fontWeight: 900, color, textShadow: glow(color), fontVariantNumeric: 'tabular-nums' }}>
      {secs}
    </div>
  );
}

const Wrap = ({ children }: { children: React.ReactNode }) => (
  <div style={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24, background: '#000', textAlign: 'center' }}>
    {children}
  </div>
);
const Big = ({ children, color }: { children: React.ReactNode; color: string }) => (
  <div style={{ fontSize: 44, fontWeight: 900, color, textShadow: glow(color) }}>{children}</div>
);
const Small = ({ children, color = TONE.NEUTRAL }: { children: React.ReactNode; color?: string }) => (
  <div style={{ fontSize: 18, color, opacity: 0.85 }}>{children}</div>
);
