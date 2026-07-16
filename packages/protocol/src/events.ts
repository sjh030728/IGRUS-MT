import { z } from 'zod';
import {
  EpochMs,
  GameId,
  MatchId,
  ParticipantId,
  ResumeToken,
  RoundId,
  SegmentId,
  Seq,
  TeamId,
} from './ids.js';
import { DisplayState, SfxCue } from './display.js';
import { LedgerEntry } from './ledger.js';
import { LiveArmSpec, LiveFrame, LivePhase, MatchCard, MatchResult, TapTugPayload } from './live.js';
import { Me, RosterEntry, Scoreboard, TeamInfo } from './session.js';
import { SuspectRow } from './anticheat.js';
import { AnswerScope } from './game.js';

/**
 * ═══ WS 이벤트 스키마 ═══
 *
 * 이름 규칙: `역할:동작` — 앞부분이 ★그대로 인증 규칙★이다.
 *   host:*    → 콘솔만. 서버가 토큰을 검사한다.
 *   play:*    → 폰.
 *   display:* → 빔.
 *
 * ★소켓의 room 소속으로 판정하면 안 된다★ 클라이언트가 join을 스스로 부를 수 있다.
 * 서버가 핸드셰이크 때 소켓에 역할을 붙이고, 미들웨어가 이벤트 이름 앞부분과 대조한다.
 * 이게 게임 전체의 무결성이다 — 폰이 host 이벤트를 쏠 수 있으면 그 순간 끝이다.
 *
 * ★설계: 사실별 이벤트가 아니라 역할별 스냅샷★
 * 전이가 일어나면 각 역할한테 "지금 니 화면 상태 전부"를 통째로 보낸다.
 * 40 클라이언트 × LAN × ~4KB면 아무 문제 없고, 재접속이 스냅샷 1발로 끝난다.
 * (델타 병합도, 리플레이도, 순서 버그도 없다.)
 * 예외는 live:frame 하나뿐 — 20Hz라 스냅샷을 태울 수 없어서 따로 나간다.
 */

/** 모든 요청의 응답 모양. */
export const Ack = <T extends z.ZodTypeAny>(data: T) =>
  z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), data }),
    z.object({ ok: z.literal(false), code: z.string(), message: z.string() }),
  ]);

// ─────────────────────────────────────────────────────────────
// 폰 → 서버
// ─────────────────────────────────────────────────────────────

/** QR 접속 후 첫 인사. resumeToken이 있으면 신원 복구, 없으면 신규. */
export const PlayHello = z.object({
  resumeToken: ResumeToken.optional(),
  name: z.string().min(1).max(20).optional(),
  teamId: TeamId.optional(),
});
export type PlayHello = z.infer<typeof PlayHello>;

/**
 * 답 제출.
 * ★roundId가 항상 붙는 이유★: 화면이 이미 넘어갔는데 늦게 도착한 제출을 거절해야 한다.
 * 재접속한 폰이 옛날 화면 상태로 제출하는 건 실제로 일어난다.
 */
export const PlaySubmit = z.object({
  roundId: RoundId,
  /** 게임마다 다르다. 서버가 게임 모듈의 parseAnswer로 넘긴다. */
  value: z.unknown(),
});
export type PlaySubmit = z.infer<typeof PlaySubmit>;

export const SubmitAck = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    at: EpochMs,
    accepted: z.unknown(),
    /** TEAM scope일 때 마지막 작성자 이름. 폰에 "우리 조 답: 배신 (김철수)"로 뜬다. */
    by: z.string().optional(),
  }),
  z.object({
    ok: z.literal(false),
    /** ★PHASE_CLOSED는 10.05초에 반드시 발생한다★ 폰은 스피너 대신 "마감됐어요"를 띄워야 한다. */
    reason: z.enum(['PHASE_CLOSED', 'WRONG_ROUND', 'NOT_IN_ROSTER', 'INVALID']),
    message: z.string(),
  }),
]);
export type SubmitAck = z.infer<typeof SubmitAck>;

/**
 * 탭 배치. ★탭 1회당 1발이 아니라 100ms 모아서 보낸다★
 * 폰이 개수만 세서 10Hz로 올린다. 배터리(위험 3위)와 대역폭 둘 다에 필요하다.
 * 서버는 이걸 그대로 믿지 않는다 — 레이트 상한이 서버에 있다.
 */
export const PlayTap = z.object({
  matchId: MatchId,
  n: z.number().int().positive().max(100),
  /** 폰 기준 배치 구간. 간격 편차 계산(로봇 탐지)에 쓴다. */
  windowMs: z.number().int().positive(),
});
export type PlayTap = z.infer<typeof PlayTap>;

// ─────────────────────────────────────────────────────────────
// 사회자 콘솔 → 서버
// ─────────────────────────────────────────────────────────────

/**
 * 사회자 명령 전부. ★명령마다 이벤트를 만들지 않는다. 이벤트 1개 + 유니온★
 *
 * (개수를 안 쓴다. 여기 "18개"라고 박혀 있었는데 ★한 번도 맞은 적이 없는 숫자였고★,
 *  learn.md 규칙 3의 예시가 그걸 베껴서 개념 노트 일곱 곳으로 번졌다. 멤버 수는 아래를
 *  세면 나온다 — 문서가 셀 일이 아니다.)
 *
 * 이유: 인증 검사 1곳, 감사 로그 1줄, phase 합법성 검증 1곳.
 * 명령을 추가한다는 건 유니온 멤버를 추가하는 것이지 게이트웨이 핸들러를 늘리는 게 아니다.
 * 여기가 보안 경계라 검사가 흩어지면 안 된다.
 */
export const HostCmd = z.discriminatedUnion('c', [
  // ── 진행 (콘솔에서 SPACE 하나에 문맥의존으로 매핑) ──
  // 문제당 5누름 × 8문제. 사회자는 마이크를 들고 있다. 어떤 버튼인지 고르게 하면 안 된다.
  z.object({ c: z.literal('ROUND_PRESENT') }), // IDLE → PROMPT
  z.object({ c: z.literal('ROUND_OPEN') }), // PROMPT → COLLECT
  /**
   * ★"5초 더!"(ROUND_EXTEND)가 여기 있었는데 뺐다. 다시 넣지 마라★ (0015)
   * CLAUDE.md 필수기능 6개 밖이었고 근거가 안 적혀 있었다. 그리고 성공 기준을 거스른다 —
   * "오디오가 죽는 구간은 게임 사이가 아니라 ★입력 대기 10초★다." 그 구간을 늘리는
   * 유일한 버튼이었다. 반대 방향(ROUND_LOCK 조기 컷)은 이미 SPACE에 있다.
   * 10초가 모자라면 잠그고 NO_SUBMIT 콜아웃으로 부른다 — 기다리는 게 아니라 부르는 게 답이다.
   */
  z.object({ c: z.literal('ROUND_LOCK') }), // COLLECT → LOCKED (조기 컷)
  z.object({ c: z.literal('ROUND_COUNTDOWN') }), // LOCKED → COUNTDOWN
  z.object({ c: z.literal('ROUND_SCORE') }), // REVEAL → REACTION ★커밋 지점★

  // ── 이동 (SPACE 아님. 다른 물리 키) ──
  // ★ROUND_NEXT가 SPACE면 안 되는 이유★: 문서가 가장 지키라는 전이(리액션 홀드)를
  // SPACE 연타로 뚫을 수 있게 된다. 유일하게 다른 손동작을 요구해야 한다.
  z.object({ c: z.literal('ROUND_NEXT') }),
  z.object({ c: z.literal('ROUND_ABORT'), reason: z.string().min(1) }),
  z.object({ c: z.literal('ROUND_GOTO'), roundId: RoundId }), // 라운드 스킵

  // ── 점수 (마우스 전용. 파괴적이라 손이 미끄러지면 안 된다) ──
  /** 낮 야외 PG 점수 수동 입력. set 의미 — 오타 나면 그냥 다시 입력. */
  z.object({
    c: z.literal('SEED_SET'),
    totals: z.record(TeamId, z.number().int()),
    note: z.string().optional(),
  }),
  /** 점수 수동 보정. 번역 릴레이 채점도, 치터 감점도 전부 이걸 쓴다. */
  z.object({
    c: z.literal('ADJUST'),
    deltas: z.record(TeamId, z.number().int()),
    reason: z.string().min(1),
  }),
  /** 되감기. 원장 기입을 지목해서 무효화한다. */
  z.object({ c: z.literal('VOID'), seq: Seq, reason: z.string().min(1) }),

  /**
   * 배점 2배 토글.
   * - 스코프: 현재 라운드 한정. ★다음 라운드 진입 시 1로 자동 리셋★
   * - 설정 가능: IDLE..REVEAL (모듈 산출물 뒤에 순수 곱셈으로 붙으니 늦게 바인딩해도 된다)
   * - 읽는 시점: 커밋 때 정확히 1회. 이후 RoundEntry.multiplier에 동결.
   *
   * ★리깅 방지는 상태머신이 아니라 투명성으로 한다★
   * 켜진 순간 빔에 형광 옐로 ×2 배지가 뜨고 절대 숨길 수 없다. 사회자가 REVEAL에서 켜도
   * ("정답은 A! ...아 그리고 이거 2배였지?") 배지가 그 순간 뜨고 방 전체가 본다.
   * 앱은 사회자를 단속하지 않는다(원칙 3). 다만 몰래는 못 하게 한다.
   *
   * 자동 리셋이 자동화가 아닌 이유: 5번에 켜고 잊으면 6~8번이 ★조용히★ 2배가 된다.
   * 그건 배지가 못 막는 오퍼레이터 오류다. "뒤 3문제 전부 2배"는 3번 누르면 되고,
   * 그러면 배지가 3번 재공지되어 오히려 오디오가 는다.
   */
  z.object({ c: z.literal('SET_MULTIPLIER'), m: z.union([z.literal(1), z.literal(2)]) }),

  /**
   * ★배점 직접 입력 — CLAUDE.md 필수기능 목록에 없는 것을 하나 추가했다★
   *
   * 근거: 문서의 알려진 위험 "배신 라운드는 2~3위가 1위를 뒤집을 수 있되 5~6위는 못 뒤집는 수준.
   * 크면 '앞에 왜 했냐', 작으면 피날레가 무의미." 이 밴드를 맞추려면 낮 PG 실측 격차를 알아야
   * 하는데 8:30 전엔 아무도 모른다. 2배 토글은 1 또는 2뿐이라 이 밴드를 못 맞춘다.
   * 이거 없으면 피날레가 도박이다.
   *
   * ★IDLE..COLLECT 에서만 합법★ score()가 LOCKED 진입 때 basePoints를 소비하기 때문이고,
   * 더 중요하게는 답을 보고 배점을 튜닝하면 그건 리깅인데 ×2 배지 같은 가시성도 없다.
   */
  z.object({ c: z.literal('SET_POINTS'), basePoints: z.number().int().positive() }),

  // ── 세그먼트 ──
  z.object({ c: z.literal('SEGMENT_GOTO'), segmentId: SegmentId }),
  /** 예비 게임 즉시 투입. CLAUDE.md 콘솔 필수기능. */
  z.object({ c: z.literal('SEGMENT_INJECT'), gameId: GameId, after: SegmentId.optional() }),

  // ── Live ──
  /** 대진 확정. 사회자가 두 조를 직접 고른다 — 브래킷 로직은 서버에 없다. */
  z.object({ c: z.literal('LIVE_ARM'), spec: LiveArmSpec }),
  z.object({ c: z.literal('LIVE_START'), matchId: MatchId }),
  z.object({ c: z.literal('LIVE_ABORT'), matchId: MatchId }),
  /** 매치 커밋. ★matchId에 대해 멱등★ — 두 번 눌러도 점수가 두 번 안 들어간다. */
  z.object({ c: z.literal('LIVE_COMMIT'), matchId: MatchId }),

  // ── 사람 관리 ──
  /** 조용히 무음 처리. ★절대 자동으로 걸리지 않는다★ 사회자만 누른다. */
  z.object({ c: z.literal('MUTE_PARTICIPANT'), participantId: ParticipantId, muted: z.boolean() }),
  /** 폰 죽은 사람한테 새 코드 발급 → 남의 폰 빌려서 재접속. 배터리 위험 대응. */
  z.object({ c: z.literal('REISSUE_TOKEN'), participantId: ParticipantId }),
  z.object({ c: z.literal('ASSIGN_PARTICIPANT'), participantId: ParticipantId, teamId: TeamId }),
  z.object({ c: z.literal('CLOSE_ENTRY') }),

  // ── 연출 ──
  /** 사운드보드. 숫자키 1~5. 리액션 8분을 덮는 유일한 도구다. */
  z.object({ c: z.literal('SFX'), cue: SfxCue }),

  /**
   * ★패닉 킬. 빔 모드를 고르는 명령이 아니다★
   *
   * 카톡 알림이 빔에 뜰 때 화면을 죽이는 백스톱. 그게 전부다.
   * ★빔 모드를 콘솔이 직접 정하는 명령은 이 계약에 없다★ — 모드는 세그먼트에서 파생된다.
   * 낮 점수 공개(SCOREBOARD_FULL)와 시상(AWARD)은 SEGMENT_GOTO로 가고, ROUND는 라운드가
   * 돌면 그 모드다. 콘솔이 모드를 따로 정할 수 있으면 "빔에 뭐가 떠 있나"의 진실이 두 줄기가
   * 되고, 둘은 반드시 어긋난다. HostSnapshot.legal을 서버가 파생해서 내려주는 것과 같은 이유다.
   *
   * ★on: boolean인 이유 — 토글이 아니다★
   * 파라미터 없는 토글이면 두 번 눌릴 때(손 떨림, 소켓 재전송) 알림이 빔에 다시 뜬다.
   * 패닉 킬은 멱등해야 한다. 그리고 복귀가 "아까 무슨 모드였지"가 아닌 이유도 여기 있다 —
   * 킬은 파생 위에 덮는 오버라이드지 이동한 자리가 아니다. 끄면 파생이 다시 보인다.
   */
  z.object({ c: z.literal('DISPLAY_BLACKOUT'), on: z.boolean() }),
]);
export type HostCmd = z.infer<typeof HostCmd>;

/** CLAUDE.md 콘솔 필수기능 대조: 스킵=ROUND_GOTO/SEGMENT_GOTO · 되감기=VOID · 수동보정=ADJUST
 *  · 2배=SET_MULTIPLIER · 낮 PG=SEED_SET · 예비 투입=SEGMENT_INJECT → 6/6 */

// ─────────────────────────────────────────────────────────────
// 서버 → 클라이언트 (역할별 스냅샷)
// ─────────────────────────────────────────────────────────────

export const DisplaySnapshot = z.object({
  state: DisplayState,
  serverNow: EpochMs,
  stateSeq: z.number().int().nonnegative(),
});
export type DisplaySnapshot = z.infer<typeof DisplaySnapshot>;

export const HostSnapshot = z.object({
  serverNow: EpochMs,
  /** 빔에 지금 뭐가 떠 있는지 미리보기. 확장 모드라 사회자한텐 안 보인다. */
  display: DisplayState,
  /** ★정답★. DisplayState엔 이 필드가 아예 없다. */
  brief: z.object({ answerText: z.string(), patter: z.string().optional() }).nullable(),
  submissions: z
    .array(
      z.object({
        participantId: ParticipantId,
        name: z.string(),
        teamId: TeamId,
        value: z.unknown(),
        at: EpochMs,
        revision: z.number().int().nonnegative(),
      }),
    )
    .readonly(),
  roster: z.array(RosterEntry).readonly(),
  /** 최근 10건. 되감기 UI가 여기서 seq를 고른다. */
  ledgerTail: z.array(LedgerEntry).readonly(),
  totals: z.record(TeamId, z.number().int()),
  /**
   * ★지금 누를 수 있는 명령. 콘솔은 이걸로 버튼을 disable한다★
   * 서버가 전이표에서 파생해서 내려주므로 콘솔이 상태머신을 재구현하지 않는다 → 드리프트 불가능.
   */
  legal: z.array(z.string()).readonly(),
  health: z.object({
    db: z.enum(['OK', 'FAIL']),
    /** 빔 브라우저가 죽었으면 ★리빌을 누르기 전에★ 알아야 한다. */
    displayConnected: z.boolean(),
    /** 빔 스피커 오토플레이 해제됐는지. 7:58에 반드시 문제가 된다. */
    displayAudioUnlocked: z.boolean(),
    phonesConnected: z.number().int().nonnegative(),
  }),
});
export type HostSnapshot = z.infer<typeof HostSnapshot>;

/**
 * 폰 화면. ★HEADS_UP이 이 계약에서 제일 중요한 뷰다★
 * 리빌 순간 폰을 죽인다. 폰이 정답을 띄우면 40명이 고개를 박고 빔이 장식이 된다.
 * REACTION에서 본인 결과를 푸는 이유: 그땐 어차피 고개를 숙이고, "야 나 맞았어"가 오디오다.
 *
 * ★/play에 점수판은 영원히 없다★ 폰에 순위가 있으면 아무도 빔을 안 보고 야유가 안 나온다.
 */
export const PlaySnapshot = z.discriminatedUnion('view', [
  z.object({ view: z.literal('LOBBY'), me: Me, teams: z.array(TeamInfo).readonly() }),
  z.object({ view: z.literal('WAIT'), me: Me, message: z.string() }),
  z.object({
    view: z.literal('INPUT'),
    me: Me,
    roundId: RoundId,
    scope: AnswerScope,
    /** 입력 UI를 그릴 정보만. ★문제 본문은 안 온다★ — 빔을 보게 하려고. */
    prompt: z.unknown(),
    endsAt: EpochMs,
    mine: z
      .object({ value: z.unknown(), at: EpochMs, by: z.string().optional() })
      .nullable(),
  }),
  /** 탭 줄다리기 중. 버튼 하나. */
  z.object({ view: z.literal('TAP'), me: Me, matchId: MatchId, eligible: z.boolean() }),
  z.object({ view: z.literal('HEADS_UP'), me: Me, mine: z.unknown().nullable() }),
  z.object({
    view: z.literal('RESULT'),
    me: Me,
    correct: z.boolean().nullable(),
    teamDelta: z.number().int(),
  }),
]);
export type PlaySnapshot = z.infer<typeof PlaySnapshot>;

// ─────────────────────────────────────────────────────────────
// 이벤트 맵 — ★이 표는 문서가 아니라 타입이다★
// Socket.IO에 Server<C2S, S2C>로 물리면 오타가 컴파일 에러가 된다.
// ─────────────────────────────────────────────────────────────

export interface C2S {
  'play:hello': (p: PlayHello, ack: (r: { ok: true; participantId: ParticipantId; resumeToken: ResumeToken; state: PlaySnapshot } | { ok: false; code: string; message: string }) => void) => void;
  'play:submit': (p: PlaySubmit, ack: (r: SubmitAck) => void) => void;
  /** ★ack 파라미터가 없다 = 무응답이 컴파일 타임에 못박힌다★ 10Hz짜리에 ack를 달면 왕복이 2배가 된다. */
  'play:tap': (p: PlayTap) => void;

  'display:hello': (p: Record<string, never>, ack: (r: { state: DisplaySnapshot }) => void) => void;
  /** 오토플레이 해제 여부 보고. 게임 권한이 없어서 인증 경계를 안 흔든다. */
  'display:status': (p: { audioUnlocked: boolean }) => void;

  'host:hello': (p: { token: string }, ack: (r: { ok: boolean; state?: HostSnapshot }) => void) => void;
  'host:cmd': (p: HostCmd, ack: (r: { ok: true } | { ok: false; code: string; message: string }) => void) => void;

  /** 접속 시 1회. LAN이라 1~3ms면 한 번으로 충분하다. 카운트다운 정확도가 여기 걸려 있다. */
  'time:ping': (p: { t0: number }, ack: (r: { t0: number; t1: EpochMs }) => void) => void;
}

export interface S2C {
  'state:display': (s: DisplaySnapshot) => void;
  'state:host': (s: HostSnapshot) => void;
  'state:play': (s: PlaySnapshot) => void;

  /** ★display room만. 20Hz. volatile★ 스냅샷 투영기를 우회하는 유일한 채널이다. */
  'live:frame': (f: LiveFrame) => void;
  /** ARM 될 때 1회. 고정 정보를 여기서 미리 줘서 프레임을 작게 유지한다. */
  'live:armed': (c: MatchCard) => void;
  /** ★host room만. 2Hz★ 작고 빠른 건 빔에, 크고 느린 건 콘솔에. */
  'live:hostTick': (t: { matchId: MatchId; payload: TapTugPayload; suspects: readonly SuspectRow[] }) => void;
  'live:phase': (p: { matchId: MatchId; phase: LivePhase; phaseStartedAt: EpochMs }) => void;
  'live:result': (r: MatchResult) => void;

  /** display room만. 사회자가 사운드보드를 누른 것. */
  'sound:sfx': (p: { cue: SfxCue; at: EpochMs }) => void;

  /** ★host room만. 절대 빔으로 안 간다★ */
  'host:alert': (a: { level: 'WARN' | 'ERROR'; code: string; message: string }) => void;
  /** 같은 신원으로 새 소켓이 들어와서 이 소켓이 밀려남. */
  'sys:bye': (p: { reason: string }) => void;
}
