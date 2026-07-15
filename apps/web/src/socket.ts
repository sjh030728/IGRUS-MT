import { io, type Socket } from 'socket.io-client';

/**
 * ★서버 URL을 하드코딩하지 않는다★
 * 폰은 공유기 LAN에서 `http://192.168.0.x:5173`으로 들어온다. localhost로 박으면
 * 폰이 자기 자신한테 붙으려 한다. hostname을 그대로 물려받으면 노트북에서도 폰에서도 맞는다.
 */
const SERVER_URL = `http://${window.location.hostname}:3000`;

/**
 * ═══ 서버 시계 ═══
 *
 * ids.ts: "와이어를 건너는 모든 시각은 서버 기준 절대 시각(epoch ms)이다."
 * 그런데 폰의 Date.now()는 서버와 다르다 — 몇 초씩 틀어진 폰이 실제로 있다.
 * 보정 안 하면 40대가 서로 다른 프레임에 0에 닿고, 그러면 카운트다운이 죽는다.
 *
 * ★접속 시 1회면 충분하다★ (events.ts time:ping) — LAN이라 왕복이 1~3ms다.
 * 3시간 동안 폰 시계가 드리프트해봐야 ms 단위라 다시 잴 이유가 없다.
 */
let offset = 0;

/** 서버 기준 지금. 화면과 소리의 모든 타이밍이 이걸 쓴다. */
export const serverNow = (): number => Date.now() + offset;

export function connect(auth: Record<string, unknown>): Socket {
  const socket = io(SERVER_URL, { transports: ['websocket'], auth });

  socket.on('connect', () => {
    const t0 = Date.now();
    socket.emit('time:ping', { t0 }, (r: { t0: number; t1: number }) => {
      const rtt = Date.now() - r.t0;
      // 왕복의 절반이 편도라고 본다. LAN에선 이 가정이 ms 오차 안에서 맞는다.
      offset = r.t1 + rtt / 2 - Date.now();
      console.log(`[clock] offset=${offset.toFixed(1)}ms rtt=${rtt}ms`);
    });
  });

  return socket;
}
