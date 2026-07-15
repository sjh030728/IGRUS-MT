---
tags:
  - 영역/데이터
---

# 트랜잭션과 ACID

> **스텁.** `/learn 트랜잭션` 으로 물어보면 채워진다. #스텁/성장

**한 줄:** 여러 작업을 "전부 되거나 전부 안 되거나" 둘 중 하나로 묶는 것. 반쯤 된 상태가
존재할 수 없게 만든다.

**왜 이 프로젝트에 있나:** [[postgres와-관계형-db]]가 파일 대신 DB를 쓰는 이유 4개 중
2번이 이거다 — 파일에 쓰다가 전원이 나가면 반 줄이 남고, 그 파일은 다음 실행 때 파싱이
터진다. 점수를 지키려고 만든 게 복구를 막는다.

**여기서 다룰 것:**
- ACID 네 글자 각각. 특히 A(원자성)와 D(지속성)가 원칙 4와 직결
- `packages/protocol/src/phase.ts` — `REVEAL → REACTION`이 **유일한 커밋 지점**인 설계.
  DB 트랜잭션의 커밋과 같은 말인가, 우연히 이름만 같은 건가
- `HostCmd`의 `LIVE_COMMIT`이 "★matchId에 대해 멱등★"인 것과 트랜잭션의 관계 → [[멱등성]]
- 커밋이 실패하면 빔에 뭐가 떠야 하나. `HostSnapshot.health.db: 'OK' | 'FAIL'`이
  계약에 이미 있는데, `FAIL`인 채로 사회자가 `ROUND_SCORE`를 누르면?

**궁금해할 만한 것:** 원장이 append-only(INSERT만, UPDATE/DELETE 없음)면 트랜잭션이 덜
필요한 거 아닌가? (힌트: 기입 1건이 INSERT 1개면 그럴 수도 있다. 근데 `RoundEntry` 하나가
`baseDeltas` + `appliedDeltas` + `detail`을 같이 넣어야 한다면?)

**관련 개념:** [[postgres와-관계형-db]], [[append-only-원장과-fold]], [[멱등성]]
