---
tags:
  - 영역/실시간
---

# 절대시각 vs 상대시간

> **스텁.** `/learn 절대시각` 으로 물어보면 채워진다. #스텁/성장

**한 줄:** 네트워크로 시간을 보낼 땐 "10초 남음"이 아니라 "1784000000000에 끝남"을 보낸다.

**이 프로젝트에서:**
- `packages/protocol/src/ids.ts` — `EpochMs`. "와이어에 duration은 절대 안 싣는다"
- `packages/protocol/src/display.ts` — `phaseEndsAt`
- `packages/protocol/src/events.ts` — `time:ping`

**왜:** "10초 남음"을 보내면 패킷이 20ms 걸린 순간 클라마다 기준이 어긋나고, 40대가 서로 다른
프레임에 0에 닿는다. 카운트다운이 제품인데 그러면 죽는다.

**한 줄이 세 개를 떠받친다:** 카운트다운 정확도 + BGM 오프셋 재개 + 재접속 시 스팅 재생 방지.

**궁금해할 만한 것:** 폰 시계가 서버와 다르면? (힌트: `time:ping`이 왜 있나) LAN이라
1~3ms인데 왜 신경 쓰나?

**관련 개념:** [[websocket과-socket-io-room]], [[스냅샷-vs-델타-동기화]]
