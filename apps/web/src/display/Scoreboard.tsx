import { useEffect, useRef, useState } from 'react';
import type { Scoreboard as Board } from '@mt/protocol';
import { TEAM_COLOR, glow } from '../theme.js';

/**
 * ★상시 노출★ CLAUDE.md: "점수판 상시 노출. 순위 변동이 보여야 야유가 나온다."
 * 청크 예산에서 이게 하나를 먹고 시작한다 (display.ts: 화면 총 4 = 점수판 + 콘텐츠 3).
 *
 * ★"고정 가구"라서 예산 초과가 허용됐다★ 눈이 한 번 익히면 그 뒤론 파싱하지 않는다.
 * 그래서 여기서 화려해지면 그 근거가 무너진다 — 움직이는 건 점수가 바뀔 때뿐이어야 한다.
 */
export function Scoreboard({ board, compact }: { board: Board; compact?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: compact ? '1.2vw' : '2vw', justifyContent: 'center', width: '100%' }}>
      {board.rows.map((r) => (
        <Row key={r.teamId} row={r} compact={!!compact} />
      ))}
    </div>
  );
}

function Row({ row, compact }: { row: Board['rows'][number]; compact: boolean }) {
  const color = TEAM_COLOR[row.color];
  const shown = useCountUp(row.total);
  // 방금 움직인 조만 델타 배지가 뜬다. 그게 "점수 애니메이션"의 전부다.
  const moved = row.lastDelta !== null && row.lastDelta !== 0;

  return (
    <div style={{ textAlign: 'center', minWidth: compact ? '8vw' : '11vw', position: 'relative' }}>
      <div style={{ fontSize: compact ? 'clamp(12px,1.1vw,20px)' : 'clamp(16px,1.5vw,28px)', color, opacity: 0.75 }}>
        {row.rank}위 · {row.name}
      </div>
      <div style={{ fontSize: compact ? 'clamp(24px,2.4vw,44px)' : 'clamp(34px,3.6vw,68px)', fontWeight: 800, color, textShadow: glow(color, moved ? 1.4 : 0.6), fontVariantNumeric: 'tabular-nums', transition: 'text-shadow 400ms' }}>
        {shown}
      </div>
      {moved && (
        // ★이름 줄 위로 띄운다★ top:0이면 "n위 · n조" 글자와 겹쳐서 음수의 −가 가려진다 —
        // 배신 라운드에서 실제로 "-300"이 "300"으로 보였다. 음수는 단계 2부터 진짜로 온다.
        <div style={{ position: 'absolute', right: '-0.5vw', top: '-1.3em', fontSize: 'clamp(14px,1.4vw,26px)', fontWeight: 800, color: row.lastDelta! > 0 ? TEAM_COLOR.GREEN : TEAM_COLOR.PINK, animation: 'mt-rise 900ms ease-out' }}>
          {row.lastDelta! > 0 ? '+' : ''}{row.lastDelta}
        </div>
      )}
    </div>
  );
}

/**
 * 점수가 튀지 않고 굴러간다. CLAUDE.md 원칙 1의 "점수 애니메이션"이 이것이다.
 * 숫자가 순간이동하면 얼마나 올랐는지 안 보이고, 안 보이면 야유가 안 나온다.
 */
function useCountUp(target: number): number {
  const [v, setV] = useState(target);
  const from = useRef(target);

  useEffect(() => {
    const start = performance.now();
    const a = from.current;
    const dur = 700;
    let raf = 0;
    const loop = (t: number) => {
      const p = Math.min(1, (t - start) / dur);
      // ease-out: 빠르게 출발해서 착지. 마지막 숫자가 읽히는 게 중요하다.
      const eased = 1 - Math.pow(1 - p, 3);
      setV(Math.round(a + (target - a) * eased));
      if (p < 1) raf = requestAnimationFrame(loop);
      else from.current = target;
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [target]);

  return v;
}
