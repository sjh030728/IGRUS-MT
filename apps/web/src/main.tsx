import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Display } from './routes/Display.js';
import { Play } from './routes/Play.js';
import { Host } from './routes/Host.js';

/**
 * ★라우터를 안 쓴다★
 * 3뷰는 서로 이동하지 않는다 — 빔은 빔에, 폰은 폰에, 콘솔은 노트북에 떠서 안 움직인다.
 * CLAUDE.md가 "물리적으로 분리"라고 부른 게 이것이다. 링크가 없으니 라우터도 없다.
 * 오히려 이게 안전장치다 — 콘솔에서 빔으로 가는 링크가 존재하지 않는다.
 */
const ROUTES: Record<string, () => JSX.Element> = {
  '/display': Display,
  '/play': Play,
  '/host': Host,
};

function App() {
  const View = ROUTES[window.location.pathname];
  if (View) return <View />;

  return (
    <div style={{ color: '#00f0ff', padding: 40, fontFamily: 'system-ui' }}>
      <h1>IGRUS MT</h1>
      <ul style={{ fontSize: 20, lineHeight: 2 }}>
        <li><a href="/display" style={{ color: '#39ff14' }}>/display</a> — 빔 (확장 모드 전체화면)</li>
        <li><a href="/play" style={{ color: '#faff00' }}>/play</a> — 폰</li>
        <li><a href="/host" style={{ color: '#ff2d95' }}>/host</a> — 콘솔 ★빔과 같은 화면에 띄우지 말 것★</li>
      </ul>
    </div>
  );
}

/**
 * ★StrictMode를 켠 채로 둔다★
 * 개발 중 effect를 두 번 돌려서 "소켓이 두 개 열린다" 같은 버그를 지금 잡게 한다.
 * 당일 밤에 알게 되는 것보다 낫다.
 */
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
