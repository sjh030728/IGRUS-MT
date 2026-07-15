import { useEffect, useState } from 'react';

/**
 * 매 프레임 다시 그리게 한다. 카운트다운/미터가 이걸 쓴다.
 *
 * ★서버가 남은 시간을 안 보내는 것의 대가다★ (ids.ts EpochMs)
 * 서버는 endsAt만 주고 "몇 초 남았나"는 각 화면이 자기 시계로 만든다.
 * 그래서 40대가 같은 프레임에 0에 닿고, 서버는 초당 40개 브로드캐스트를 안 한다.
 */
export function useServerClock(): void {
  const [, force] = useState(0);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      force((n) => n + 1);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
}
