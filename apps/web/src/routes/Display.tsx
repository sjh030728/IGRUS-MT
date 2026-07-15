import { useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import type { DisplaySnapshot } from '@mt/protocol';
import { connect } from '../socket.js';
import { sound } from '../sound/engine.js';
import { driveSound } from '../sound/derive.js';
import { Chunk, CountdownCtx } from '../display/Chunk.js';
import { Scoreboard } from '../display/Scoreboard.js';
import { TONE, glow } from '../theme.js';

/**
 * ═══ 빔 뷰 ═══ CLAUDE.md: 빔프로젝터 전체화면. 확장 모드 전제.
 *
 * ★여기 정답이 없다★ 타입에 필드가 아예 없어서 실수로도 못 띄운다(display.ts).
 * ★스냅샷 받아서 그리기만 한다★ 클라 상태가 거의 없다 — 그게 React를 고른 이유다.
 */
export function Display() {
  const [snap, setSnap] = useState<DisplaySnapshot | null>(null);
  const [audioReady, setAudioReady] = useState(false);
  const sockRef = useRef<Socket | null>(null);

  useEffect(() => {
    const socket = connect({ role: 'display' });
    sockRef.current = socket;
    socket.on('connect', () => {
      socket.emit('display:hello', {}, (r: { state: DisplaySnapshot }) => setSnap(r.state));
      socket.emit('display:status', { audioUnlocked: sound.unlocked });
    });
    socket.on('state:display', (s: DisplaySnapshot) => setSnap(s));
    return () => { socket.close(); sockRef.current = null; };
  }, []);

  // ★소리를 상태에서 파생시킨다. 여기가 그 유일한 호출 지점이다★
  useEffect(() => {
    if (snap && audioReady) driveSound(snap.state);
  }, [snap, audioReady]);

  const [unlockFailed, setUnlockFailed] = useState(false);

  const unlock = async () => {
    const ok = await sound.unlock();
    setAudioReady(ok);
    setUnlockFailed(!ok);
    // ★기존 소켓으로 보고한다★ 여기서 connect()를 또 부르면 소켓이 두 개가 되고,
    // display room 인원이 2로 잡혀서 health.displayConnected가 거짓말을 한다.
    sockRef.current?.emit('display:status', { audioUnlocked: ok });
  };

  if (!snap) return <Center><span style={{ color: TONE.NEUTRAL, fontSize: 32 }}>연결 중…</span></Center>;

  /**
   * ★7:58에 반드시 문제가 된다★ 브라우저는 제스처 없이 소리를 안 낸다.
   * 빔은 아무도 안 만지는 화면이라, 이 관문이 없으면 무음으로 프로그램이 시작된다.
   * 그건 성공 기준 위반이라 화면 전체를 덮어서 못 지나치게 한다.
   */
  if (!audioReady) {
    return (
      <Center>
        <button onClick={unlock} style={{ background: '#000', border: `4px solid ${TONE.HOT}`, color: TONE.HOT, textShadow: glow(TONE.HOT), boxShadow: glow(TONE.HOT), fontSize: 'clamp(28px,3vw,56px)', fontWeight: 800, padding: '4vh 6vw', borderRadius: 20, cursor: 'pointer' }}>
          클릭해서 사운드 켜기
        </button>
        <div style={{ color: TONE.NEUTRAL, opacity: 0.7, fontSize: 'clamp(16px,1.6vw,26px)', marginTop: '3vh' }}>
          소리 없는 리빌 루프는 리빌 루프가 아니다 — 시작 전 반드시 누를 것
        </div>
        {/* 실패해도 말은 해준다. 같은 버튼이 조용히 다시 뜨면 눌렀는지 아닌지도 모른다. */}
        {unlockFailed && (
          <div style={{ color: TONE.BAD, fontSize: 'clamp(16px,1.6vw,26px)', marginTop: '2vh' }}>
            해제 실패 — 이 창을 클릭해서 포커스를 준 뒤 다시 누르세요
          </div>
        )}
      </Center>
    );
  }

  const s = snap.state;

  // 패닉 킬. 카톡 알림이 빔에 떴을 때. 진짜로 아무것도 안 그린다.
  if (s.mode === 'BLACK') return <div style={{ height: '100%', background: '#000' }} />;

  if (s.mode === 'SCOREBOARD_FULL' || s.mode === 'AWARD') {
    return (
      <Center>
        <div style={{ fontSize: 'clamp(40px,5vw,96px)', fontWeight: 900, color: TONE.HOT, textShadow: glow(TONE.HOT, 1.5), marginBottom: '6vh' }}>
          {s.mode === 'AWARD' ? '시상' : s.title}
        </div>
        <Scoreboard board={s.scoreboard} />
      </Center>
    );
  }

  const r = s.round;
  return (
    <CountdownCtx.Provider value={r.phaseEndsAt}>
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', padding: '3vh 3vw', gap: '2vh' }}>
        {/* 헤더 — 청크 예산을 안 먹는 자리다 (display.ts) */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: TONE.NEUTRAL, opacity: 0.7, fontSize: 'clamp(16px,1.6vw,28px)' }}>
          <span>{r.segmentTitle} · {r.index}/{r.total}</span>
          {/* ★×2 배지는 절대 숨길 수 없다★ 사회자가 REVEAL에서 켜도 방 전체가 본다 */}
          {r.multiplier === 2 && (
            <span style={{ color: TONE.HOT, textShadow: glow(TONE.HOT, 1.5), fontWeight: 900, fontSize: 'clamp(24px,2.6vw,48px)', animation: 'mt-pulse 900ms infinite' }}>
              ×2
            </span>
          )}
        </div>

        {/* 콘텐츠 — 최대 3청크 */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '3vh' }}>
          {r.content.map((c, i) => <Chunk key={i} c={c} />)}
        </div>

        {/* 점수판 — 상시 */}
        <Scoreboard board={s.scoreboard} compact />
      </div>
    </CountdownCtx.Provider>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: '#000' }}>
      {children}
    </div>
  );
}
