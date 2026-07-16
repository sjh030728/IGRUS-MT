import { z } from 'zod';
import type {
  EpochMs,
  GameId,
  ParticipantId,
  RoundId,
  SegmentId,
  TeamId,
} from './ids.js';
import type { ContentChunks } from './display.js';
import type { LiveArmSpec, MatchOutcome, TapTugPayload } from './live.js';
import type { RosterEntry, TeamInfo } from './session.js';

/**
 * ★이 파일의 인터페이스가 Zod가 아니라 순수 TypeScript인 이유★
 *
 * Zod는 "런타임에도 검사가 필요한 것"에 쓴다. 즉 와이어를 건너오는 것 — 폰이 보낸 데이터.
 * 폰은 남의 컴퓨터라 뭐가 올지 모르니 실행 중에 확인해야 한다.
 *
 * 이 파일의 인터페이스는 와이어를 안 건넌다. 우리 서버 코드가 우리 게임 모듈을 부르는
 * 함수 모양일 뿐이다. 컴파일러가 이미 다 잡아준다. 여기에 Zod를 쓰면
 * 런타임 비용만 내고 얻는 게 없다.
 *
 * ★예외가 정확히 하나다: AnswerScope★ 저건 z.enum이고, 이 파일의 유일한 Zod다.
 * events.ts의 HostSnapshot이 `scope: AnswerScope`로 와이어에 싣기 때문이다.
 * 규칙은 "이 파일은 Zod 금지"가 아니라 ★"와이어를 건너는 것만 Zod"★이고, 여기서 그걸
 * 건너는 건 저거 하나다. (원래 이 문단이 "이 파일만 Zod가 아니라"로 시작했는데
 * :1이 `import { z }`라 첫 줄부터 거짓이었다. 결정은 맞았고 서술이 틀렸다.)
 *
 * 경계는 parseAnswer()다 — unknown이 들어와서 T가 나가는 그 지점이 검증이 사는 유일한 곳이고,
 * 거기서 게임 모듈이 자기 Zod 스키마를 쓴다.
 */

/**
 * 답안이 어느 슬롯에 떨어지는가. ★코어가 아는 전략의 전부다★
 *
 * 처음엔 fold 전략 enum(first-wins / majority / representative / independent)을 넣으려 했는데
 * 기각됐다. 그 4개는 한 enum이 아니라 서로 다른 4개 개념이 모자를 나눠 쓰고 있었다:
 *   - independent   = fold의 부재 (팀 답이 아예 없음. 팀 점수가 있을 뿐)
 *   - representative= 제출 자격 규칙 (reduce가 아니라 auth)
 *   - majority      = 게임 로직 (동점 나면 타이브레이크 enum이 또 필요해짐)
 *   - first-wins    = 게임 로직 (팀원 간 레이스)
 * 첫 멤버가 "해당없음"인 enum은 틀린 추상이다.
 *
 * 퀴즈 · 배신 라운드 · 번역 릴레이가 전부 아래 2멤버로 커버된다.
 * (슬라이더/두진실이 여기 있었는데 CLAUDE.md "이미 검토하고 뺀 것들"로 갔다.
 *  개수를 안 쓰는 이유가 이거다 — 목록이 움직인다.)
 * fold가 필요한 게임은 fold를 자기 모듈 코드로 짠다. 지금 그런 게임은 0개다.
 */
export const AnswerScope = z.enum([
  /** 슬롯 키 = participantId. 40명이 각자 낸다. 퀴즈. */
  'PARTICIPANT',
  /**
   * 슬롯 키 = teamId. 조당 하나. 배신 라운드.
   *
   * ★조장 지정도 다수결도 아니다. 아무 조원이나 누르되 잠금까지 계속 덮어쓰기다★
   * 이게 다른 안들보다 전부 나은 이유:
   *  - 조장 폰 배터리 사망 = 조 전멸, 이라는 단일 실패점이 없다 (CLAUDE.md 위험 3위)
   *  - 10초 내내 "아니 잠깐 바꿔! 협력으로!"가 터진다 — 성공 기준에 대한 가능한 최선의 답
   *  - 서버가 마지막 작성자와 번복 이력 전체를 안다. 리액션에서
   *    "3조 최종 배신. 마지막에 누른 건 이영희. 4번 번복함" 이 나온다.
   *    docs/program-ops.md가 말한 "야 니네 왜 배신했어"가 공짜로 나온다.
   *  - 다수결은 집계가 배신자를 익명화해서 그 안주를 죽인다.
   */
  'TEAM',
]);
export type AnswerScope = z.infer<typeof AnswerScope>;

/** 제출 1건. 항상 개인이 낸다 — 폰은 사람이 든다. */
export interface SubmissionRecord<T = unknown> {
  participantId: ParticipantId;
  teamId: TeamId;
  value: T;
  at: EpochMs;
  /** 0부터. 잠금 전까진 덮어쓸 수 있고, 그 이력이 리액션의 재료다. */
  revision: number;
}

/**
 * 잠금 시점에 동결된 제출 묶음. 게임의 score()가 받는 것.
 *
 * ★log를 절대 안 버린다★ 팀 단위로 접더라도 개인 기록은 전량 남긴다.
 * 이유는 docs/program-ops.md의 "OO이 나와봐" — 엣지에서 접으면 사회자가 지목할 데이터가 사라진다.
 */
export type SubmissionBag<T = unknown> = {
  log: readonly SubmissionRecord<T>[];
  roster: readonly RosterEntry[];
  teams: readonly TeamInfo[];
} & (
  | { scope: 'PARTICIPANT'; final: ReadonlyMap<ParticipantId, SubmissionRecord<T>> }
  | { scope: 'TEAM'; final: ReadonlyMap<TeamId, SubmissionRecord<T>> }
);

export type ParseResult<T> =
  | { ok: true; value: T }
  /** message는 폰에 그대로 뜬다. 사람이 읽을 문장으로 쓸 것. */
  | { ok: false; reason: 'INVALID' | 'OUT_OF_RANGE'; message: string };

/**
 * 사회자가 REACTION에서 지목할 사람들.
 * ★이게 앱 전체에서 제일 중요한 데이터다★
 * docs/program-ops.md: 내부 퀴즈는 실행 8분에 리액션 8분이고, "정답 공개하고 'OO이 나와봐'
 * 하는 그 시간이 콘텐츠이지 낭비가 아니다. 앱이 점수만 띄우고 넘어가면 게임의 절반을 버리는 것."
 *
 * 개수가 아니라 ★이름★이어야 한다. 사회자가 손가락으로 가리킬 대상이다.
 * 이름이 없으면 사회자가 기억해내야 하고, 그러면 "OO이 나와봐"가 죽는다.
 */
export interface Callout {
  kind: 'CORRECT' | 'WRONG' | 'NO_SUBMIT' | 'NOTABLE';
  participantId?: ParticipantId;
  teamId?: TeamId;
  /** "김철수 (3조)" */
  label: string;
  /** "협력→배신→협력→배신 (4번 번복)" */
  note?: string;
}

/** 사회자 콘솔에만 가는 것. DisplayRoundView엔 이 필드가 없다 — 빔 정답 유출이 컴파일 에러가 된다. */
export interface HostBrief {
  answerText: string;
  /** 진행 멘트 힌트. "이거 신입생은 모를 수도 있어요" 같은 것. */
  patter?: string;
}

/**
 * 라운드 1개의 명세. ★적재 후 불변★
 * 이 불변식이 되감기와 재시작 복구를 재현 가능하게 만든다.
 *
 * 3-투영에 주목: 같은 문제가 빔/폰/콘솔에 서로 다른 모양으로 간다.
 * CLAUDE.md "빔 뷰와 콘솔은 절대 같은 화면에 뜨면 안 된다"가 규율이 아니라 타입이 된다.
 */
export interface RoundSpec<TPlayPrompt = unknown> {
  roundId: RoundId;
  segmentId: SegmentId;
  index: number;
  total: number;
  /** 빔. 정답 없음 — 타입에 필드 자체가 없다. */
  displayPrompt: { title: string; content: ContentChunks };
  /** 폰. 입력 UI를 그릴 정보만. ★문제 본문은 안 간다★ */
  playPrompt: TPlayPrompt;
  /** 콘솔 전용. 정답이 여기 있다. */
  hostBrief: HostBrief;
  basePoints: number;
  /** 입력 수집 시간. 퀴즈 10_000 / 배신 30_000 */
  collectMs: number;
  /** 두구두구 길이. 퀴즈 3_000 / 배신 5_000. 시간에 쫓기면 이걸 줄이는 게 탈출구다. */
  countdownMs: number;
}

export interface ScoreResult {
  /** 배수 적용 전. 부호 있는 정수 — 배신 라운드는 음수가 난다. */
  baseDeltas: ReadonlyMap<TeamId, number>;
  /**
   * REVEAL에서 빔이 ★한 프레임에★ 그릴 것. 조별 순차 플립 금지 — "동시 공개"는 문자 그대로다.
   *
   * ★제네릭이 아니라 ContentChunks인 이유★ (단계 1에서 고침)
   * 원래 TReveal = unknown 이었는데 코어가 그걸 쓸 수가 없었다:
   *  - 빔이 받는 DisplayRoundView.content는 ContentChunks다. 빔은 DisplayChunk 말고
   *    그릴 줄 아는 게 없고, 그게 청크 예산(MAX_CONTENT_CHUNKS)의 존재 이유다
   *  - Game 유니온이 제네릭을 지운다(LockRevealGame<unknown, unknown> — 0009). 코어가 보는
   *    reveal은 unknown이 되고, unknown은 그릴 수가 없다
   *  - reveal은 와이어에 자기 표현이 없다 — content를 통하지 않으면 빔에 갈 경로가 없다
   * 즉 제네릭이면 게임이 낸 리빌을 띄울 방법이 없다. displayPrompt.content가 이미
   * ContentChunks인 것과 대칭을 맞춘다 — 문제도 리빌도 같은 어휘로 그린다.
   */
  reveal: ContentChunks;
  callouts: readonly Callout[];
}

export interface LoadCtx {
  segmentId: SegmentId;
  teams: readonly TeamInfo[];
  roster: readonly RosterEntry[];
}

/**
 * ═══ LockReveal 게임 인터페이스 ═══
 *
 * CLAUDE.md 원칙 2: "문제 제시 → 입력 수집 → 잠금 → 카운트다운 → 동시 공개 → 채점"
 * 당일: 내부 퀴즈, 배신 라운드. 예비: 번역 릴레이 (정원 1개 — CLAUDE.md).
 *
 * ★메서드 3개. 라이프사이클 훅 없음★
 * onPhaseEnter / beforeLock 같은 걸 열어주면 거기로 3번째 게임 타입이 기어들어온다.
 * 훅이 필요한 게임은 LockReveal이 아니고, 그러면 CLAUDE.md에 따라 만들지 않는다.
 */
export interface LockRevealGame<TPlayPrompt = unknown, TAnswer = unknown> {
  readonly gameId: GameId;
  readonly kind: 'LOCK_REVEAL';
  readonly title: string;
  readonly answerScope: AnswerScope;

  /**
   * 세그먼트 투입 시 1회. 문제은행(Postgres) 조회는 여기서 끝낸다.
   * ★라운드 진행 중 DB 접근 금지★ — 8시 35분에 쿼리가 느려지면 리빌이 늦는다.
   *
   * ★반드시 결정적일 것. ORDER BY random() 금지★
   * 재시작 복구가 roundId 일치에 의존한다. 어차피 손으로 고른 8문제다.
   */
  loadRounds(ctx: LoadCtx): Promise<readonly RoundSpec<TPlayPrompt>[]>;

  /**
   * COLLECT 중 제출마다. 순수 함수.
   * ★unknown → ParseResult<T> 이 경계가 이 프로젝트에서 검증이 사는 유일한 지점이다★
   * 여기서 게임 모듈이 자기 Zod 스키마를 쓴다.
   */
  parseAnswer(round: RoundSpec<TPlayPrompt>, raw: unknown): ParseResult<TAnswer>;

  /**
   * LOCKED 진입 시 1회. 순수 + 결정적 (되감기/재시작 때 다시 돌아도 같은 답이 나와야 한다).
   * ★배수를 보지 못한다★ — 코어가 곱한다. 게임이 배수를 알면 두 곳에서 곱해진다.
   */
  score(round: RoundSpec<TPlayPrompt>, bag: SubmissionBag<TAnswer>): ScoreResult;
}

/**
 * ═══ Live 게임 인터페이스 ═══
 *
 * CLAUDE.md 원칙 2: "연속 입력 스트림 → 빔에 실시간 반영. 리빌 딜레이 없음."
 * 당일: 탭 줄다리기. 그게 전부다.
 *
 * ★게임이 직접 emit하거나 persist하지 않는다★ 엔진이 tick()을 20Hz로 부르고 결과를 뿌린다.
 * 게임은 순수한 누산기다. 탭 줄다리기 구현은 이 인터페이스 위에서 ~30줄이면 끝나는데,
 * 게임이 하찮은 게 계약이 제자리에 있다는 신호다 — 단계 3이 "Live 엔진 + 탭 줄다리기"이고
 * 엔진이 그 단계의 전부다.
 */
export interface LiveGame<TPayload = TapTugPayload> {
  readonly gameId: GameId;
  readonly kind: 'LIVE';
  readonly title: string;
  /** 서버 엔진이 이 상한으로 자른다. 게임은 인정된 수만 본다. */
  readonly rate: { perSec: number; burst: number };

  /** ARM 될 때. 누산기 초기화. */
  arm(spec: LiveArmSpec): void;

  /**
   * 레이트 상한을 통과한 탭만 들어온다.
   * ★버려진 탭은 여기 안 온다★ — 안티치트는 엔진 레벨이고 게임은 몰라도 된다.
   */
  accept(participantId: ParticipantId, credited: number): void;

  /**
   * 엔진이 20Hz로 부른다. 빔에 그릴 페이로드를 내고, 끝났으면 end를 채운다.
   * ★Live는 스스로 종료를 선언할 수 있지만(KO/시간종료) 커밋은 못 한다★ — 커밋은 사회자다.
   */
  tick(elapsedMs: number): { payload: TPayload; end?: MatchOutcome };

  /** ENDED 후 커밋 때 1회. 배수 적용 전 델타. */
  settle(outcome: MatchOutcome): ReadonlyMap<TeamId, number>;
}

/**
 * ★게임 타입은 영원히 2개다★ CLAUDE.md 원칙 2: "3번째를 만들지 마라."
 * 코어가 kind로 분기하는 곳은 정확히 한 군데(세그먼트 러너)뿐이다.
 *
 * ★never가 아니라 unknown인 이유★ (단계 1에서 고침)
 * 원래 <never, never, never>였는데 그러면 ★어떤 게임도 이 타입에 못 들어간다★.
 * loadRounds가 Promise<readonly RoundSpec<TPlayPrompt>[]>를 반환하는데 이건 공변 위치라,
 * RoundSpec<QuizPrompt>를 RoundSpec<never>에 넣으려면 QuizPrompt가 never에 대입돼야 한다.
 * 그런 타입은 없다. 즉 레지스트리가 비어 있을 때만 컴파일되는 타입이었다.
 * unknown은 반대 방향이라 전부 들어간다 — 지우개로 쓸 값은 바닥(never)이 아니라 천장(unknown)이다.
 */
export type Game = LockRevealGame<unknown, unknown> | LiveGame;
