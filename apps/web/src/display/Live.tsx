import type { DisplayState, LiveFrame, Scoreboard as ScoreboardT } from '@mt/protocol';
import { TEAM_COLOR, TONE, glow } from '../theme.js';
import { serverNow } from '../socket.js';
import { useServerClock } from '../useServerClock.js';
import { Scoreboard } from './Scoreboard.js';

type LiveState = Extract<DisplayState, { mode: 'LIVE' }>;

/**
 * ═══ 탭 줄다리기 빔 화면 ═══ 밤 전체의 피크. 뒷줄에서도 바 하나면 다 읽힌다.
 *
 * 화면 예산(display.ts): 점수판 + 대진 캡션 + 바 = 3. 멤버 모양 자체가 예산이다.
 *
 * ★조 이름·색이 스냅샷의 매치엔 없다★ (live.ts LiveSide) — teamId로 점수판에서 찾는다.
 * 진실이 한 줄기라 콘솔이 라벨을 지어낼 방법이 없다.
 */
export function LiveView({ s, frame }: { s: LiveState; frame: LiveFrame | null }) {
  const a = teamOf(s.scoreboard, s.card.a.teamId);
  const b = teamOf(s.scoreboard, s.card.b.teamId);
  // 프레임이 지금 매치 것일 때만 쓴다 — 지난 매치의 마지막 프레임이 새 매치 위에 그려지면 안 된다.
  const pos = frame && frame.matchId === s.card.matchId ? frame.payload.pos : s.pos;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', padding: '3vh 3vw', gap: '2vh' }}>
      {/* 헤더 — 청크 예산을 안 먹는 자리 (라운드 뷰와 같은 규칙) */}
      <div style={{ display: 'flex', justifyContent: 'space-between', color: TONE.NEUTRAL, opacity: 0.7, fontSize: 'clamp(16px,1.6vw,28px)' }}>
        <span>탭 줄다리기</span>
        <span style={{ color: TONE.HOT }}>{s.card.basePoints}점</span>
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '4vh' }}>
        <Matchup a={a} b={b} />
        <Stage s={s} a={a} b={b} pos={pos} />
      </div>

      {/* 점수판 — 상시 */}
      <Scoreboard board={s.scoreboard} compact />
    </div>
  );
}

type Side = { name: string; color: string };

function teamOf(board: ScoreboardT, teamId: string): Side {
  const row = board.rows.find((r) => r.teamId === teamId);
  return { name: row?.name ?? teamId, color: row ? TEAM_COLOR[row.color] : TONE.NEUTRAL };
}

function Matchup({ a, b }: { a: Side; b: Side }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: '3vw', fontWeight: 900, fontSize: 'clamp(40px,6vw,104px)' }}>
      <span style={{ color: a.color, textShadow: glow(a.color) }}>{a.name}</span>
      <span style={{ color: TONE.NEUTRAL, opacity: 0.6, fontSize: '0.5em' }}>VS</span>
      <span style={{ color: b.color, textShadow: glow(b.color) }}>{b.name}</span>
    </div>
  );
}

function Stage({ s, a, b, pos }: { s: LiveState; a: Side; b: Side; pos: number }) {
  switch (s.phase) {
    // "대표 나와!" 구간. ARMED가 5분 — 오디오는 사회자 멘트가 맡는다 (live.ts).
    case 'ARMED':
      return <div style={{ fontSize: 'clamp(28px,3.4vw,56px)', color: TONE.HOT, textShadow: glow(TONE.HOT), fontWeight: 800 }}>대표 나와!</div>;

    case 'COUNTDOWN':
      return <GoCountdown endsAt={s.phaseEndsAt} />;

    case 'ACTIVE':
      return (
        <>
          <TugBar pos={pos} a={a} b={b} />
          <Timer endsAt={s.phaseEndsAt} />
        </>
      );

    case 'ENDED':
      return <Outcome s={s} a={a} b={b} pos={pos} />;

    default: // IDLE — 스냅샷엔 match=null이라 오지 않는다 (projector)
      return null;
  }
}

/** GO 착지. 소리(derive.ts)와 같은 근거(phaseEndsAt)를 쓰므로 "GO!"와 화면이 같은 프레임이다. */
function GoCountdown({ endsAt }: { endsAt: number | null }) {
  useServerClock();
  if (endsAt === null) return null;
  const n = Math.ceil(Math.max(0, endsAt - serverNow()) / 1000);
  return (
    <div key={n} style={{ fontSize: 'clamp(160px,30vw,460px)', fontWeight: 900, color: TONE.HOT, textShadow: glow(TONE.HOT, 2.5), lineHeight: 1, animation: 'mt-pop 240ms ease-out' }}>
      {n > 0 ? n : 'GO!'}
    </div>
  );
}

/**
 * ★바 하나가 화면의 전부다★ -1000 = 왼쪽(a) 완승, +1000 = 오른쪽(b) 완승.
 * 20Hz 프레임 사이는 CSS 트랜지션이 보간한다 (live.ts LiveFrame 주석).
 */
function TugBar({ pos, a, b }: { pos: number; a: Side; b: Side }) {
  // 중앙 기준 좌우로 미는 마커. pos<0이면 a(왼쪽) 우세 — a 색이 영역을 먹는다.
  const pct = 50 + (pos / 1000) * 50; // 0..100, 마커의 가로 위치
  const leading = pos < 0 ? a : pos > 0 ? b : null;
  return (
    <div style={{ width: '90%', maxWidth: '86vw' }}>
      <div style={{ position: 'relative', height: 'clamp(48px,9vh,110px)', borderRadius: 999, border: `4px solid ${TONE.NEUTRAL}66`, background: '#000', overflow: 'hidden' }}>
        {/* 우세한 쪽 색이 중앙에서 마커까지 차오른다 */}
        <div
          style={{
            position: 'absolute', top: 0, bottom: 0,
            left: `${Math.min(50, pct)}%`, width: `${Math.abs(pct - 50)}%`,
            background: leading ? leading.color : 'transparent',
            boxShadow: leading ? glow(leading.color) : 'none',
            transition: 'left 60ms linear, width 60ms linear',
          }}
        />
        {/* 중앙선 */}
        <div style={{ position: 'absolute', top: 0, bottom: 0, left: '50%', width: 3, background: `${TONE.NEUTRAL}88` }} />
        {/* 마커 */}
        <div
          style={{
            position: 'absolute', top: '8%', bottom: '8%', width: 'clamp(14px,1.4vw,24px)',
            left: `calc(${pct}% - clamp(7px,0.7vw,12px))`,
            borderRadius: 999, background: '#fff', boxShadow: glow('#ffffff'),
            transition: 'left 60ms linear',
          }}
        />
      </div>
      {/* KO 선 라벨 — 어느 끝이 누구인지. 바 밖이라 예산을 안 먹는다. */}
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '1vh', fontSize: 'clamp(18px,2vw,34px)', fontWeight: 800 }}>
        <span style={{ color: a.color, textShadow: glow(a.color, 0.6) }}>◀ {a.name} KO선</span>
        <span style={{ color: b.color, textShadow: glow(b.color, 0.6) }}>{b.name} KO선 ▶</span>
      </div>
    </div>
  );
}

/** 시간은 프레임이 아니라 phaseEndsAt에서 파생 — 프레임이 다 죽어도 시계는 간다 (live.ts). */
function Timer({ endsAt }: { endsAt: number | null }) {
  useServerClock();
  if (endsAt === null) return null;
  const remain = Math.max(0, endsAt - serverNow());
  const secs = Math.ceil(remain / 1000);
  const tone = remain < 5000 ? TONE.BAD : remain < 10000 ? TONE.HOT : TONE.NEUTRAL;
  return (
    <div style={{ fontSize: 'clamp(40px,5vw,88px)', fontWeight: 800, color: tone, textShadow: glow(tone), fontVariantNumeric: 'tabular-nums' }}>
      {secs}
    </div>
  );
}

function Outcome({ s, a, b, pos }: { s: LiveState; a: Side; b: Side; pos: number }) {
  const o = s.outcome;
  if (!o) return null;

  if (o.kind === 'VOID') {
    return <div style={{ fontSize: 'clamp(40px,6vw,104px)', fontWeight: 900, color: TONE.BAD, textShadow: glow(TONE.BAD) }}>무효</div>;
  }
  const winner = o.winner === null ? null : o.winner === s.card.a.teamId ? a : b;
  return (
    <>
      {winner ? (
        <div style={{ fontSize: 'clamp(56px,9vw,160px)', fontWeight: 900, color: winner.color, textShadow: glow(winner.color, 2), animation: 'mt-pop 240ms ease-out' }}>
          {o.kind === 'KO' ? 'KO! ' : ''}{winner.name} 승!
        </div>
      ) : (
        <div style={{ fontSize: 'clamp(56px,9vw,160px)', fontWeight: 900, color: TONE.HOT, textShadow: glow(TONE.HOT, 2) }}>무승부!</div>
      )}
      {/* 끝난 바를 그대로 둔다 — "얼마나 아슬아슬했나"가 리액션의 재료다 */}
      <TugBar pos={pos} a={a} b={b} />
    </>
  );
}
