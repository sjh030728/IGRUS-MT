---
tags:
  - 영역/계약-타입
---

# 타입 vs 런타임 검증

**한 줄:** TypeScript 타입은 컴파일할 때만 존재하고 실행 중엔 사라지므로, 밖에서 들어온
데이터를 막으려면 별도의 런타임 검증이 필요하다.

## 왜 필요한가 — 문제부터

이 코드는 타입상 완벽하다:

```ts
socket.on('play:submit', (data: { roundId: string }) => {
  data.roundId.trim();
});
```

그런데 폰이 `{ roundId: 999 }`를 보내면 `.trim()`에서 터진다. 타입을 붙였는데 왜?

**TypeScript 타입은 컴파일 후 사라지기 때문이다.** `tsc`가 만든 JavaScript를 열어보면
타입 표기가 전부 지워져 있다. 남는 건 이것뿐이다:

```js
socket.on('play:submit', (data) => { data.roundId.trim(); });
```

브라우저와 Node가 실행하는 건 이거다. 검사는 아무 데도 없다.

### 그럼 타입은 뭘 검사한 건가

**우리 코드가 우리끼리 한 약속을 지키는지**만 검사했다. 내가 `data.roundId`를 `number`처럼
쓰면 컴파일러가 잡아준다. 그건 진짜 유용하다.

하지만 **`data`가 실제로 어떻게 생겼는지는 검사한 적이 없다.** `(data: { roundId: string })`은
"이렇게 생겼을 것이다"라는 **내 주장**이지 확인이 아니다. 컴파일러는 그 주장을 믿는다.

내 코드 안에서만 도는 값이면 그 믿음이 맞다. 내가 만들었으니까.
**밖에서 온 값이면 틀린다.** 폰은 남의 컴퓨터다.

### 우리 프로젝트에선 이게 이론이 아니다

CLAUDE.md 위험목록 1위:

> "IT동아리다. 탭 줄다리기에서 콘솔로 이벤트 뿌리는 시도가 **반드시** 나온다.
> 서버에서 탭 레이트 상한(인간 한계 ~15tap/s) + 이상치 감지 필수."

누군가 크롬 개발자도구를 열고 이걸 친다:

```js
setInterval(() => socket.emit('play:tap', { n: 50 }), 10);
```

**가능성이 아니라 예정이다.** 그러면 런타임 검증은 선택 사항이 아니다.

## 순진한 해결책과 그 문제

정의를 두 벌 쓰면 된다:

```ts
type Submit = { roundId: string };                 // 컴파일용
function isSubmit(x: any): x is Submit {           // 런타임용 — 손으로 또 짬
  return typeof x?.roundId === 'string';
}
```

동작한다. 문제는 **두 벌이 어긋나는 게 시간문제**라는 것. 6주 뒤 `Submit`에 `value` 필드를
추가하면서 `isSubmit`을 안 고친다. 컴파일은 통과한다 — 검증 함수가 필드를 덜 보는 건
타입 에러가 아니니까. 그리고 그 구멍으로 조작된 데이터가 들어온다.

**두 벌 관리는 결국 한 벌이 뒤처지는 것으로 끝난다.**

## Zod — 정의 한 벌로 둘 다

```ts
const Submit = z.object({ roundId: z.string() });
type Submit = z.infer<typeof Submit>;   // ← 타입을 스키마에서 뽑는다

Submit.parse(들어온데이터);              // ← 런타임 검사도 같은 정의로
```

`z.infer`가 핵심이다. 타입을 **손으로 안 쓴다.** 스키마에서 자동으로 뽑는다.
그래서 스키마를 고치면 타입이 따라 바뀌고, **어긋날 방법이 없다.**

자세한 건 [[스키마-기반-타입-추론]].

## 이 프로젝트에서

`packages/protocol/src/events.ts`:

```ts
export const PlayTap = z.object({
  matchId: MatchId,
  n: z.number().int().positive().max(100),
  windowMs: z.number().int().positive(),
});
export type PlayTap = z.infer<typeof PlayTap>;
```

`.max(100)`이 위의 `setInterval` 공격을 막는다. `.int()`는 `n: 1.5` 같은 장난을,
`.positive()`는 `n: -50`(점수 깎기)을 막는다.

**실제로 막히는지는 `packages/protocol/verify.ts`에서 확인한다.** `npm run verify`:

```
[2] 탭 조작 — 개발자도구로 이벤트 뿌리는 시나리오 (CLAUDE.md 위험 1위)
  OK   정상 배치 통과
  OK   n=999999 거절 (배치 상한)
  OK   n=0 거절
  OK   n 소수 거절
```

## 언제 쓰고 언제 안 쓰나

**경계를 넘는 데이터에만 쓴다.** 경계 = 내가 안 만든 값이 들어오는 지점.

| 쓴다 | 안 쓴다 |
|---|---|
| WS/HTTP로 들어온 것 | 내 함수가 내 함수를 부를 때 |
| 폼 입력 | 이미 검증된 값을 넘길 때 |
| 파일/DB에서 읽은 것 | 상수 |
| 외부 API 응답 | |

**남용하면 손해다.** 검증은 공짜가 아니고(런타임 비용), 이미 검증된 값을 또 검증하는 건
느리기만 하다. 경계에서 **한 번** 하고 그 뒤론 타입을 믿는다.

### 이 프로젝트의 실제 경계선

`packages/protocol/src/game.ts`는 **일부러 Zod를 안 쓴다.** 파일 상단 주석:

> Zod는 "런타임에도 검사가 필요한 것"에 쓴다. 즉 와이어를 건너오는 것 — 폰이 보낸 데이터.
> 이 파일의 인터페이스는 와이어를 안 건넌다. 우리 서버 코드가 우리 게임 모듈을 부르는
> 함수 모양일 뿐이다. 여기에 Zod를 쓰면 런타임 비용만 내고 얻는 게 없다.

경계는 딱 한 군데다 — `parseAnswer(round, raw: unknown): ParseResult<TAnswer>`.
`unknown`이 들어와서 `T`가 나가는 그 지점이 이 프로젝트에서 검증이 사는 유일한 곳이다.

**`unknown`이라는 타입 자체가 경계 표시다.** `any`가 아니라 `unknown`을 쓰면 컴파일러가
"검사하기 전엔 아무것도 못 한다"고 강제한다. 밖에서 온 값은 `unknown`으로 받는 게 맞다.

---

**관련 결정:** [[0002-와이어-검증은-zod-단일정의로-한다]]
**관련 개념:** [[스키마-기반-타입-추론]], [[판별-유니온]]
