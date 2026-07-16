import type { DisplayChunk } from '@mt/protocol';
import { TONE, glow } from '../theme.js';
import { useServerClock } from '../useServerClock.js';
import { serverNow } from '../socket.js';

/**
 * ★게임이 자유롭게 HTML을 그리는 게 아니라 이 중에서 고른다★ (display.ts)
 * "뒷줄 가독성은 게임마다 다시 판단할 문제가 아니라 한 번 정하고 끝낼 문제다."
 * 그래서 새 게임을 추가해도 이 파일은 안 바뀐다. 바뀌면 뭔가 잘못된 것이다.
 */
export function Chunk({ c }: { c: DisplayChunk }) {
  switch (c.t) {
    // 문제 본문. display.ts가 ≥96px을 요구한다.
    case 'headline':
      return (
        <div style={{ fontSize: 'clamp(48px, 7vw, 112px)', fontWeight: 800, color: TONE.NEUTRAL, textShadow: glow(TONE.NEUTRAL), lineHeight: 1.15, textAlign: 'center' }}>
          {c.text}
        </div>
      );

    case 'caption':
      return (
        <div style={{ fontSize: 'clamp(24px, 3vw, 48px)', color: TONE.NEUTRAL, opacity: 0.85, textShadow: glow(TONE.NEUTRAL, 0.5) }}>
          {c.text}
        </div>
      );

    case 'choices':
      return (
        <div style={{ display: 'grid', gap: '2vh', width: '100%', maxWidth: '80vw' }}>
          {c.items.map((it, i) => (
            <div key={i} style={{ fontSize: 'clamp(28px, 3.4vw, 56px)', fontWeight: 700, color: TONE[it.tone], textShadow: glow(TONE[it.tone], 0.6), border: `3px solid ${TONE[it.tone]}66`, borderRadius: 12, padding: '1.2vh 2vw' }}>
              {it.label}
            </div>
          ))}
        </div>
      );

    // 동시 공개가 여기에 한 프레임으로 뜬다. 조별 순차 플립 금지.
    case 'grid':
      return (
        <div style={{ display: 'flex', gap: '2vw', flexWrap: 'wrap', justifyContent: 'center', width: '100%' }}>
          {c.cells.map((cell, i) => (
            <div key={i} style={{ border: `4px solid ${TONE[cell.tone]}`, borderRadius: 16, padding: '2vh 2.5vw', minWidth: '14vw', textAlign: 'center', boxShadow: glow(TONE[cell.tone], 0.7) }}>
              <div style={{ fontSize: 'clamp(18px, 1.8vw, 30px)', color: TONE[cell.tone], opacity: 0.8 }}>{cell.label}</div>
              <div style={{ fontSize: 'clamp(36px, 4.5vw, 76px)', fontWeight: 800, color: TONE[cell.tone], textShadow: glow(TONE[cell.tone]) }}>{cell.value}</div>
            </div>
          ))}
        </div>
      );

    case 'meter':
      return <Meter endsAt={c.endsAt} got={c.got} of={c.of} />;

    case 'bignum':
      return <BigNum />;

    // tugbar 케이스가 있었는데 어휘에서 빠졌다 — 줄다리기는 청크가 아니라 LIVE 모드
    // 전용 화면(display/Live.tsx)이다. 빠짐없음 검사가 이 주석의 사실 여부를 지킨다.
  }
}

/**
 * ★"37/40"이 사회자의 "3조 아직도 안 냈어!"를 가능하게 한다★
 * display.ts가 이걸 사망구간 해법의 핵심이라고 부른다. 미터는 장식이 아니다.
 */
function Meter({ endsAt, got, of }: { endsAt: number; got: number; of: number }) {
  useServerClock();
  const remain = Math.max(0, endsAt - serverNow());
  const secs = Math.ceil(remain / 1000);
  // 임박하면 색이 바뀐다. 소리만이 아니라 눈으로도 조여야 한다.
  const tone = remain < 3000 ? TONE.BAD : remain < 6000 ? TONE.HOT : TONE.NEUTRAL;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '3vw' }}>
      <div style={{ fontSize: 'clamp(40px, 5vw, 88px)', fontWeight: 800, color: tone, textShadow: glow(tone), fontVariantNumeric: 'tabular-nums', minWidth: '3ch', textAlign: 'right' }}>
        {secs}
      </div>
      <div style={{ fontSize: 'clamp(32px, 4vw, 72px)', fontWeight: 800, color: TONE.GOOD, textShadow: glow(TONE.GOOD, 0.7), fontVariantNumeric: 'tabular-nums' }}>
        {got}/{of}
      </div>
    </div>
  );
}

/**
 * ★숫자를 서버가 안 보낸다. 여기서 phaseEndsAt으로 파생한다★
 * 서버는 bignum{n:0}만 얹고 실제 값은 빔이 만든다 — 소리와 같은 근거를 쓰므로
 * 화면의 "1"과 틱 소리가 같은 프레임에 떨어진다. 서버가 n을 보내면 그게 어긋난다.
 */
function BigNum() {
  useServerClock();
  const ctx = useCountdownCtx();
  if (!ctx) return null;
  const remain = Math.max(0, ctx - serverNow());
  const n = Math.ceil(remain / 1000);
  if (n <= 0) return null;

  return (
    <div
      key={n} // key가 바뀌면 애니메이션이 다시 돈다 — 숫자마다 한 번씩 튄다
      style={{
        fontSize: 'clamp(160px, 30vw, 460px)',
        fontWeight: 900,
        color: TONE.HOT,
        textShadow: glow(TONE.HOT, 2.5),
        lineHeight: 1,
        animation: 'mt-pop 240ms ease-out',
      }}
    >
      {n}
    </div>
  );
}

/** BigNum이 endsAt을 알아야 하는데 청크엔 없다. Display가 context로 내려준다. */
import { createContext, useContext } from 'react';
export const CountdownCtx = createContext<number | null>(null);
const useCountdownCtx = () => useContext(CountdownCtx);
