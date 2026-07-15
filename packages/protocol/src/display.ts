import { z } from 'zod';
import { EpochMs, RoundId, SegmentId, TeamId } from './ids.js';
import { RoundPhase } from './phase.js';
import { Scoreboard } from './session.js';

/** 형광 팔레트. CLAUDE.md 타협 금지: "배경 #000 + 형광 텍스트. 회색 계열 UI 금지." */
export const Tone = z.enum([
  'NEUTRAL', // 형광 시안
  'GOOD', // 형광 그린 — 정답 / 점수 상승
  'BAD', // 형광 핑크 — 오답 / 점수 하락 / 배신
  'HOT', // 형광 옐로 — 강조 / ×2 배지
]);
export type Tone = z.infer<typeof Tone>;

/**
 * 빔에 그릴 정보 덩어리 하나.
 * 게임 모듈이 자유롭게 HTML을 그리는 게 아니라 이 중에서 고른다.
 * 이유: 뒷줄 가독성은 게임마다 다시 판단할 문제가 아니라 한 번 정하고 끝낼 문제다.
 */
export const DisplayChunk = z.discriminatedUnion('t', [
  /** 문제 본문. ≥96px. */
  z.object({ t: z.literal('headline'), text: z.string() }),
  /** 객관식 보기. */
  z.object({
    t: z.literal('choices'),
    items: z.array(z.object({ label: z.string(), tone: Tone })).readonly(),
  }),
  z.object({ t: z.literal('caption'), text: z.string() }),
  /** 조별 답 격자. 동시 공개가 여기에 한 프레임으로 뜬다. */
  z.object({
    t: z.literal('grid'),
    cells: z.array(z.object({ label: z.string(), value: z.string(), tone: Tone })).readonly(),
  }),
  /**
   * 링 타이머 + 진행률을 한 덩어리로 묶은 것.
   * "37/40"이 사회자의 "3조 아직도 안 냈어!"를 가능하게 한다 — 사망구간 해법의 핵심.
   */
  z.object({
    t: z.literal('meter'),
    endsAt: EpochMs,
    got: z.number().int().nonnegative(),
    of: z.number().int().positive(),
  }),
  /** 카운트다운 3-2-1. 화면을 가득 채운다. */
  z.object({ t: z.literal('bignum'), n: z.number().int() }),
  /** 탭 줄다리기 바. -1000(왼쪽 승) ~ +1000(오른쪽 승). */
  z.object({
    t: z.literal('tugbar'),
    pos: z.number().int().min(-1000).max(1000),
    left: z.object({ label: z.string(), tone: Tone }),
    right: z.object({ label: z.string(), tone: Tone }),
  }),
]);
export type DisplayChunk = z.infer<typeof DisplayChunk>;

/**
 * ★청크 예산★ — CLAUDE.md "화면에 정보 덩어리 4개 이상 금지"
 *
 * 문서 문구를 그대로 읽으면 최대 3인데, "점수판 상시 노출"이 하나를 먹고 시작하므로
 * 게임이 쓸 수 있는 건 2가 된다. 그러면 입력 수집 구간(질문 + 보기 + 진행률 미터)이
 * 예산을 넘는다. 진행률 미터를 버리면 사회자가 "3조 아직 안 냈어!"를 할 근거가 사라지는데,
 * 그건 문서가 직접 처방한 사망구간 해법이다.
 *
 * → 판단: 화면 총 4 = 점수판(항상) + 콘텐츠 최대 3.
 *   문서 문구를 1개 초과하는 의도적 결정이다. 근거는 점수판이 매 프레임 다시 읽는 정보가
 *   아니라 고정 가구에 가깝다는 것 — 눈이 한 번 익히면 그 뒤론 파싱하지 않는다.
 *
 * 검산:
 *   COLLECT  = 점수판 + 질문 + 보기 + 미터        = 4 (정확히 예산)
 *   REVEAL   = 점수판 + 정답 + 조별 답 격자        = 3
 *   COUNTDOWN= 점수판 + 질문(흐리게) + 거대 숫자   = 3
 *   탭 ACTIVE= 점수판 + 대진 캡션 + 바             = 3
 * 여유가 거의 없다. W7 리허설에서 뒷줄 가독성을 반드시 실측할 것.
 */
export const MAX_CONTENT_CHUNKS = 3;

export const ContentChunks = z.array(DisplayChunk).max(MAX_CONTENT_CHUNKS).readonly();
export type ContentChunks = z.infer<typeof ContentChunks>;

/**
 * 빔이 받는 라운드 뷰.
 *
 * ★여기 answerText 같은 필드가 없다는 게 핵심이다★
 * CLAUDE.md: "빔 뷰와 콘솔은 절대 같은 화면에 뜨면 안 된다. 콘솔에 정답이 있다."
 * 정답은 HostBrief(콘솔 전용)에만 있다. 빔에 정답을 흘리려면 이 타입에 필드를 추가해야 하고,
 * 그러면 리뷰에서 걸린다. 규율이 아니라 타입으로 막는다.
 */
export const DisplayRoundView = z.object({
  phase: RoundPhase,
  segmentId: SegmentId,
  roundId: RoundId,
  phaseStartedAt: EpochMs,
  /**
   * ★COLLECT / COUNTDOWN 에서만 값이 있고 나머진 전부 null★
   * 타입이 "리빌 이후엔 타이머가 없다"를 직접 말한다. AutoTransition 2멤버와 한 쌍.
   */
  phaseEndsAt: EpochMs.nullable(),
  segmentTitle: z.string(),
  index: z.number().int().positive(),
  total: z.number().int().positive(),
  /** 2면 형광 옐로 ×2 배지. 청크 예산을 안 먹는 헤더 속성이다. 숨길 수 없다. */
  multiplier: z.union([z.literal(1), z.literal(2)]),
  content: ContentChunks,
  /** REACTION 에서만 non-null. 그 전엔 절대 안 내려간다 — 사전 유출 방지. */
  deltas: z.record(TeamId, z.number().int()).nullable(),
});
export type DisplayRoundView = z.infer<typeof DisplayRoundView>;

/**
 * 빔 전체 상태.
 * BLACK 말고 전부 scoreboard를 필수로 요구한다 → "점수판 상시 노출"이 타입이 된다.
 */
export const DisplayState = z.discriminatedUnion('mode', [
  /**
   * 패닉 킬. 카톡 알림이 빔에 뜰 때의 백스톱. 현장 체크리스트 항목의 소프트웨어판.
   *
   * ★나머지 3개와 종류가 다르다★ SCOREBOARD_FULL/AWARD/ROUND는 세그먼트에서 파생된 상태고,
   * BLACK은 그 파생 위에 덮인 오버라이드(HostCmd DISPLAY_BLACKOUT)가 투영된 것이다.
   * 그래서 여기 필드가 없다 — 덮을 뿐 자리를 뺏지 않으니 복원할 정보도 없다.
   */
  z.object({ mode: z.literal('BLACK') }),
  /** 8:00 낮 점수 공개 / 8:44 시상. */
  z.object({
    mode: z.literal('SCOREBOARD_FULL'),
    title: z.string(),
    scoreboard: Scoreboard,
  }),
  z.object({ mode: z.literal('AWARD'), scoreboard: Scoreboard }),
  z.object({
    mode: z.literal('ROUND'),
    scoreboard: Scoreboard,
    round: DisplayRoundView,
  }),
]);
export type DisplayState = z.infer<typeof DisplayState>;

/**
 * 사운드 큐.
 *
 * 구조적인 소리(틱, 스팅, BGM)는 서버가 이벤트로 쏘지 않는다. 빔이 phase + phaseEndsAt에서
 * 스스로 파생한다. 이유:
 *  - 틱을 3발 쏘면 LAN 지터 때문에 소리와 화면이 어긋난다. endsAt을 주고 빔이 로컬에서
 *    스케줄하면 "0"이 정확히 그 프레임에 떨어진다.
 *  - 진실이 한 줄기라 재접속이 간단하다. 상태 스냅샷 하나만 다시 받으면 소리도 맞는다.
 *  - CLAUDE.md 분담: B가 빔+사운드. 파생이면 사운드 튜닝에 서버 코드를 1줄도 안 건드린다.
 *
 * ★재접속 스팅 억제★: 큐는 phase가 실제로 바뀌었고 now - phaseStartedAt < 1500 일 때만 발화한다.
 * 안 그러면 REACTION 중에 빔이 새로고침될 때 리빌 스팅이 다시 터진다.
 *
 * 아래 SfxCue는 그 파생 규칙에 안 잡히는 것 — 사회자가 손으로 누르는 사운드보드다.
 */
export const SfxCue = z.enum([
  'DRUMROLL', // 두구두구
  'BOO', // 야유
  'APPLAUSE', // 박수
  'CRICKETS', // 귀뚜라미 (썰렁할 때)
  'AIRHORN', // 에어혼
]);
export type SfxCue = z.infer<typeof SfxCue>;

/**
 * 사운드보드가 원칙 3 위반이 아니라 원칙 3의 가장 순수한 구현인 이유:
 *
 * 자동 두구두구는 앱이 "지금 긴장이 존재한다"를 판단하는 것 — 사회자의 타이밍 감각을 대체한다.
 * (CLAUDE.md가 "마피아 자동 사회자"를 뺀 바로 그 이유다.)
 * 수동 패드는 자동화가 0이고 사회자 출력의 배수다. 농담하고 야유 누르면 방이 더 웃는다.
 *
 * 그리고 이게 스펙의 구조적 구멍을 메운다:
 * docs/program-ops.md — 내부 퀴즈는 실행 10분 / 리액션 9분이다. REACTION은 런타임의 절반이면서
 * 동시에 phase 파생 오디오가 설계상 무음인 유일한 phase다(사회자가 말하니까).
 * 사회자가 한 박자 쉬면 정적이다. 사운드보드가 그 9분을 덮는 유일한 도구다.
 * 카운트다운 틱은 3초짜리다. 이게 더 중요하다.
 *
 * 콘솔에서 숫자키 1~5에 바인딩할 것. 마우스로 찾게 하면 안 쓴다.
 */
