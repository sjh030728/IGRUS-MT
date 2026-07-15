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
      const choices = (snap.prompt as { choices?: readonly string[] })?.choices ?? [];
      const mine = snap.mine?.value as string | undefined;
      return (
        <Wrap>
          <Countdown endsAt={snap.endsAt} />
          {/* ★문제 본문이 여기 없다★ 빔을 보게 하려고 계약이 안 보낸다 */}
          <Small>화면을 보고 고르세요</Small>
          <div style={{ display: 'grid', gap: 12, width: '100%', marginTop: 16 }}>
            {choices.map((c) => (
              <button
                key={c}
                onClick={() => submit(snap.roundId, c)}
                style={{
                  padding: '22px 0', fontSize: 30, fontWeight: 800, borderRadius: 14, cursor: 'pointer',
                  background: mine === c ? teamColor : '#000',
                  color: mine === c ? '#000' : teamColor,
                  border: `3px solid ${teamColor}`,
                  boxShadow: mine === c ? glow(teamColor) : 'none',
                }}
              >
                {c}
              </button>
            ))}
          </div>
          {mine && <Small>제출됨: {mine} · 잠금 전까진 바꿀 수 있어요</Small>}
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
          {snap.mine != null && <Small>내 답: {String(snap.mine)}</Small>}
        </Wrap>
      );

    // 그땐 어차피 고개를 숙인다. "야 나 맞았어"가 오디오다.
    case 'RESULT': {
      const up = snap.teamDelta > 0;
      return (
        <Wrap>
          <Small>{snap.me.teamName}</Small>
          <Big color={up ? TEAM_COLOR.GREEN : TEAM_COLOR.PINK}>
            {up ? '+' : ''}{snap.teamDelta}
          </Big>
          <Small>{up ? '올랐어요' : '이번엔 없네요'}</Small>
        </Wrap>
      );
    }

    case 'TAP':
      return <Wrap><Small>탭 줄다리기는 단계 3</Small></Wrap>;
  }
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
