import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Subject } from 'rxjs';
import {
  LEGAL_LIVE_TRANSITIONS,
  MatchId,
  RoundId,
  type AnomalyFlag,
  type EpochMs,
  type LiveArmSpec,
  type LiveFrame,
  type LiveGame,
  type LivePhase,
  type ParticipantId,
  type SuspectRow,
  type TapTugPayload,
} from '@mt/protocol';
import { LedgerService } from './ledger.service.js';
import { RoundService } from './round.service.js';
import type { ActiveMatch, TapAccount } from './state.js';

const now = (): EpochMs => Date.now();

/** GO 직전 두구두구. 게임 상수가 아니라 연출 상수라 엔진에 산다. */
const COUNTDOWN_MS = 3_000;
/** 20Hz. live.ts LiveFrame — "사람 눈은 20Hz 위를 구분 못 하고, 바는 CSS로 보간된다." */
const FRAME_MS = 50;
/** 2Hz. 콘솔 의심 목록 — 크고 느린 건 콘솔에. */
const HOST_TICK_MS = 500;

type NavResult = { ok: true } | { ok: false; message: string };

/**
 * ═══ Live 엔진 ═══ 단계 3의 본체. "엔진이 그 단계의 전부다" (game.ts).
 *
 * 소유: 매치 상태머신(LivePhase) / 레이트 상한 / 이상치 감지 / 20Hz 프레임 / 커밋.
 * 게임 모듈은 인정된 탭만 받는 누산기다 — 안티치트에 손이 닿지 않는다 (anticheat.ts).
 *
 * ★라운드 머신(round.service)과 절대 합치지 않는다★ (live.ts: "공통 조상 금지")
 * 상태는 RoundService가 소유한 SessionState의 match 슬롯에 산다 — 스냅샷 투영기가
 * 상태 하나만 보고 3뷰를 만들 수 있어야 해서다. 엔진은 그 슬롯의 유일한 작성자다.
 */
@Injectable()
export class LiveService implements OnModuleDestroy {
  /** 빔으로 가는 20Hz 프레임. 게이트웨이가 구독해서 display room에 volatile로 쏜다. */
  readonly frames$ = new Subject<LiveFrame>();
  /** 콘솔로 가는 2Hz. 의심 목록은 ★host room에만★ (anticheat.ts — 오탐 공개는 그 밤을 끝낸다). */
  readonly hostTicks$ = new Subject<{ matchId: MatchId; payload: TapTugPayload; suspects: readonly SuspectRow[] }>();

  private timer: NodeJS.Timeout | null = null;
  private matchSeq = 0;
  private lastHostTickAt = 0;
  /** ACTIVE 진입 시각. tick(elapsedMs)의 기준점. */
  private activeStartedAt = 0;

  constructor(
    private readonly rounds: RoundService,
    private readonly ledger: LedgerService,
  ) {
    // 라운드 러너의 10ms 틱과 같은 패턴 — 틱이 매번 상태를 다시 읽으므로 재스케줄 버그가 없다.
    this.timer = setInterval(() => this.tick(), FRAME_MS);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private get state() {
    return this.rounds.state;
  }

  /** 현재 세그먼트의 Live 게임. 아니면 null — 모든 진입점이 이걸로 거른다. */
  private liveGame(): LiveGame | null {
    const g = this.state.segment?.game;
    return g?.kind === 'LIVE' ? g : null;
  }

  // ── 사회자 명령 ────────────────────────────────────────────

  /**
   * 대진 확정. ★matchId는 여기서 채번한다★ (live.ts LiveArmSpec — 콘솔 발명 금지)
   * ENDED 위에 arm하면 이전 매치가 밀려나므로, 미커밋 실결과 위에는 거절한다 —
   * 점수가 조용히 증발하는 것보다 사회자가 COMMIT/ABORT를 한 번 더 누르는 게 낫다.
   */
  arm(spec: LiveArmSpec): NavResult {
    const game = this.liveGame();
    if (!game) return { ok: false, message: 'Live 세그먼트가 아님' };

    const m = this.state.match;
    if (m && !(m.phase === 'ENDED' && (m.committed || m.outcome?.kind === 'VOID'))) {
      return { ok: false, message: '매치 진행 중 — 먼저 커밋 또는 ABORT' };
    }

    if (spec.a.teamId === spec.b.teamId) return { ok: false, message: '같은 조끼리는 못 붙는다' };
    for (const t of [spec.a.teamId, spec.b.teamId]) {
      if (!this.state.teams.some((x) => x.teamId === t)) return { ok: false, message: `없는 조: ${t}` };
    }
    // 로스터에 없는 대표는 거절 — 콘솔 UI가 로스터에서 고르므로 걸리면 콘솔 버그다.
    for (const p of [...spec.a.eligible, ...spec.b.eligible]) {
      if (!this.state.roster.has(p)) return { ok: false, message: '로스터에 없는 대표가 있음' };
    }

    const matchId = MatchId.parse(`m${++this.matchSeq}`);
    this.state.match = {
      matchId,
      spec,
      durationMs: game.durationMs,
      phase: 'ARMED',
      phaseStartedAt: now(),
      phaseEndsAt: null,
      pos: 0,
      seq: 0,
      outcome: null,
      committed: false,
      accounts: new Map(),
    };
    game.arm(spec);
    this.rounds.bump();
    return { ok: true };
  }

  start(matchId: string): NavResult {
    const m = this.requireMatch(matchId);
    if (!m.ok) return m;
    if (!this.enter(m.match, 'COUNTDOWN')) return { ok: false, message: 'ARMED에서만 시작' };
    return { ok: true };
  }

  /**
   * phase 의존 되돌리기/폐기 (events.ts LIVE_ABORT):
   * ARMED→해산 / COUNTDOWN→ARMED / ACTIVE→VOID로 종결 / ENDED→폐기.
   */
  abort(matchId: string): NavResult {
    const m = this.requireMatch(matchId);
    if (!m.ok) return m;
    const match = m.match;

    switch (match.phase) {
      case 'ARMED':
        this.state.match = null; // IDLE로 — 대진 자체를 무른다
        break;
      case 'COUNTDOWN':
        this.enter(match, 'ARMED'); // 카운트다운만 취소, 대진은 유지
        break;
      case 'ACTIVE':
        // ★되감기가 아니라 VOID 종결★ (live.ts: ACTIVE에서 나가는 길은 ENDED뿐)
        match.outcome = { kind: 'VOID', reason: '사회자 중단' };
        this.enter(match, 'ENDED');
        break;
      case 'ENDED':
        this.state.match = null; // 미커밋 결과 폐기 또는 커밋 후 정리
        break;
      default:
        return { ok: false, message: '지금은 못 무름' };
    }
    this.rounds.bump();
    return { ok: true };
  }

  /**
   * ★Live의 커밋 지점. 여기서만 점수가 영속화된다★ — 라운드의 REVEAL→REACTION과 한 쌍.
   * matchId에 대해 멱등: 두 번째 누름은 아무것도 안 쌓고 성공을 돌려준다.
   */
  commit(matchId: string): NavResult {
    const m = this.requireMatch(matchId);
    if (!m.ok) return m;
    const match = m.match;
    const game = this.liveGame();
    if (!game) return { ok: false, message: 'Live 세그먼트가 아님' };

    if (match.phase !== 'ENDED' || !match.outcome) return { ok: false, message: 'ENDED에서만 커밋' };
    if (match.outcome.kind === 'VOID') return { ok: false, message: '무효 매치는 커밋 없음 — 새로 arm' };
    if (match.committed) return { ok: true }; // ★멱등★ 원장에 두 번 안 쌓인다

    const deltas: Record<string, number> = {};
    for (const [teamId, d] of game.settle(match.outcome)) deltas[teamId] = d;

    this.ledger.append({
      kind: 'ROUND',
      sessionId: this.state.sessionId,
      at: now(),
      by: 'HOST',
      segmentId: this.state.segment!.def.segmentId,
      // Live엔 라운드가 없다 — 원장의 roundId 칸엔 매치 식별자를 그대로 도장 찍는다.
      roundId: RoundId.parse(match.matchId),
      matchId: match.matchId,
      gameId: game.gameId,
      multiplier: 1, // ×2 토글은 Live에 없다 — 판돈은 arm의 basePoints로 (live.ts)
      basePoints: match.spec.basePoints,
      baseDeltas: deltas,
      appliedDeltas: deltas,
      // 개인 단위를 안 버린다 — 탭 장부가 아카이브의 "OO이 나와봐" 재료다.
      detail: {
        outcome: match.outcome,
        finalPos: match.pos,
        a: match.spec.a,
        b: match.spec.b,
        taps: [...match.accounts.entries()].map(([pid, a]) => ({
          participantId: pid,
          credited: a.credited,
          dropped: a.dropped,
          flags: [...a.flags],
        })),
      },
    });

    match.committed = true;
    this.rounds.bump();
    return { ok: true };
  }

  // ── 폰 탭 (ack 없음 — 실패는 조용히) ──────────────────────

  /**
   * ★여기가 안티치트 전부다★ (anticheat.ts)
   * "넘친 탭은 거절이 아니라 그냥 버린다. 폰에 에러를 띄우면 정상 참가자가
   *  자기가 잘못한 줄 알고 손을 멈춘다. 조용히 상한선까지만 인정한다."
   */
  tap(pid: ParticipantId, socketId: string, matchId: string, n: number, _windowMs: number): void {
    const m = this.state.match;
    const game = this.liveGame();
    // 지난 매치·시작 전 탭은 조용히 버린다 — 10Hz 채널에 거절 왕복을 달지 않는다.
    if (!m || !game || m.matchId !== matchId || m.phase !== 'ACTIVE') return;

    const t = now();
    const acc = this.accountOf(m, pid, t);
    acc.sockets.add(socketId);
    if (acc.sockets.size > 1) this.flag(acc, 'DUPLICATE_SOCKET', t);

    // eligible 밖의 탭: 인정 0, 표식만. 실수일 수도, 아닐 수도 — 판단은 사회자다.
    const eligible = m.spec.a.eligible.includes(pid) || m.spec.b.eligible.includes(pid);
    if (!eligible) {
      this.flag(acc, 'NOT_ELIGIBLE', t);
      acc.dropped += n;
      return;
    }

    // ── 토큰 버킷: burst가 용량, perSec가 충전 ──
    const { perSec, burst } = game.rate;
    acc.tokens = Math.min(burst, acc.tokens + ((t - acc.lastRefillAt) / 1000) * perSec);
    acc.lastRefillAt = t;
    const credited = Math.min(n, Math.floor(acc.tokens));
    acc.tokens -= credited;
    acc.credited += credited;
    acc.dropped += n - credited;

    // ── 이상치 장부 ──
    acc.batchAt.push(t);
    if (acc.batchAt.length > 64) acc.batchAt.shift();
    this.updateAnomalies(acc, t, perSec);

    if (credited > 0) game.accept(pid, credited);
  }

  // ── 자동 전이 + 프레임 (50ms 틱) ───────────────────────────

  /**
   * ★Live의 자동 전이는 정확히 2개다★ (live.ts LiveAutoTransition — verify §8이 센다)
   * COUNTDOWN_ZERO: GO 착지 / MATCH_END: KO 또는 시간 종료. 나머지는 전부 사회자다.
   */
  private tick(): void {
    const m = this.state.match;
    const game = this.liveGame();
    if (!m || !game) return;

    const t = now();

    if (m.phase === 'COUNTDOWN' && m.phaseEndsAt !== null && t >= m.phaseEndsAt) {
      this.enter(m, 'ACTIVE'); // COUNTDOWN_ZERO
    }

    if (m.phase !== 'ACTIVE') return;

    const { payload, end } = game.tick(t - this.activeStartedAt);
    m.pos = payload.pos;
    m.seq++;
    this.frames$.next({ matchId: m.matchId, seq: m.seq, serverNow: t, payload });

    if (t - this.lastHostTickAt >= HOST_TICK_MS) {
      this.lastHostTickAt = t;
      this.hostTicks$.next({ matchId: m.matchId, payload, suspects: this.suspects(m, t) });
    }

    if (end) {
      m.outcome = end;
      this.enter(m, 'ENDED'); // MATCH_END — 물리지 판단이 아니다
    }
  }

  // ── 내부 ───────────────────────────────────────────────────

  private requireMatch(matchId: string): { ok: true; match: ActiveMatch } | { ok: false; message: string } {
    const m = this.state.match;
    if (!m) return { ok: false, message: '매치 없음 — 먼저 ARM' };
    // 늦게 도착한 클릭이 다음 매치를 조작하는 걸 막는다 (제출의 WRONG_ROUND와 같은 원리).
    if (m.matchId !== matchId) return { ok: false, message: '지난 매치의 명령' };
    return { ok: true, match: m };
  }

  /** ★전이는 전부 이 문을 지난다★ — round.service의 enter와 한 쌍. 표는 protocol에 한 벌뿐. */
  private enter(m: ActiveMatch, to: LivePhase): boolean {
    if (!LEGAL_LIVE_TRANSITIONS[m.phase].includes(to)) return false;

    m.phase = to;
    m.phaseStartedAt = now();
    m.phaseEndsAt =
      to === 'COUNTDOWN' ? now() + COUNTDOWN_MS
      : to === 'ACTIVE' ? now() + m.durationMs
      : null;

    if (to === 'ACTIVE') this.activeStartedAt = now();
    this.rounds.bump();
    return true;
  }

  private accountOf(m: ActiveMatch, pid: ParticipantId, t: EpochMs): TapAccount {
    let acc = m.accounts.get(pid);
    if (!acc) {
      const burst = this.liveGame()?.rate.burst ?? 0;
      acc = { tokens: burst, lastRefillAt: t, credited: 0, dropped: 0, batchAt: [], peakPerSec: 0, sockets: new Set(), flags: new Set(), flaggedAt: null };
      m.accounts.set(pid, acc);
    }
    return acc;
  }

  private flag(acc: TapAccount, f: AnomalyFlag, t: EpochMs): void {
    acc.flags.add(f);
    if (acc.flaggedAt === null) acc.flaggedAt = t;
  }

  private updateAnomalies(acc: TapAccount, t: EpochMs, perSec: number): void {
    // 최근 1초 인정 속도의 최대치 — 배치 수 근사가 아니라 credited 합이 필요하지만,
    // 상한이 토큰 버킷이라 "1초에 인정될 수 있는 최대 = perSec + 잔여 burst"다. 근사로 충분하다.
    const oneSecAgo = acc.batchAt.filter((x) => t - x <= 1000).length;
    acc.peakPerSec = Math.max(acc.peakPerSec, oneSecAgo);

    // PINNED_AT_CAP: 최근 5초 내내 버킷이 바닥 = 지속적으로 상한에 붙어 있음.
    // 혼자 15.0tap/s를 5초+ 유지하는 사람은 없다 (anticheat.ts). dropped가 쌓이는 게 그 증거다.
    const recent = acc.batchAt.filter((x) => t - x <= 5000);
    if (recent.length >= 20 && acc.tokens < 1 && acc.dropped > perSec) {
      this.flag(acc, 'PINNED_AT_CAP', t);
    }

    // ROBOTIC_INTERVAL: 배치 도착 간격이 너무 규칙적 — setInterval의 지문.
    // 사람 손 + 폰 타이머 + 무선랜을 다 거치면 간격이 반드시 떨린다.
    if (acc.batchAt.length >= 20) {
      const gaps: number[] = [];
      for (let i = 1; i < acc.batchAt.length; i++) gaps.push(acc.batchAt[i]! - acc.batchAt[i - 1]!);
      if (stdev(gaps) < 4) this.flag(acc, 'ROBOTIC_INTERVAL', t);
    }
  }

  /** flag가 붙은 사람만. ★host room 전용 데이터★ — 빔 스냅샷엔 이 모양이 아예 없다. */
  private suspects(m: ActiveMatch, t: EpochMs): SuspectRow[] {
    const out: SuspectRow[] = [];
    for (const [pid, acc] of m.accounts) {
      if (acc.flags.size === 0) continue;
      const person = this.state.roster.get(pid);
      const gaps: number[] = [];
      for (let i = 1; i < acc.batchAt.length; i++) gaps.push(acc.batchAt[i]! - acc.batchAt[i - 1]!);
      out.push({
        participantId: pid,
        name: person?.name ?? '?',
        teamId: person?.teamId ?? this.state.teams[0]!.teamId,
        flags: [...acc.flags],
        stats: {
          participantId: pid,
          credited: acc.credited,
          dropped: acc.dropped,
          intervalStdevMs: Math.round(stdev(gaps) * 10) / 10,
          peakPerSec: acc.peakPerSec,
        },
        since: acc.flaggedAt ?? t,
      });
    }
    return out;
  }
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return Number.POSITIVE_INFINITY; // 표본 부족 = 판단 유보 (로봇 아님 쪽으로)
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / xs.length);
}
