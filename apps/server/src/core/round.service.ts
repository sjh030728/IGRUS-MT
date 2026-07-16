import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Subject } from 'rxjs';
import {
  LEGAL_TRANSITIONS,
  ParticipantId,
  SessionId,
  TeamId,
  type EpochMs,
  type Game,
  type GameId,
  type LockRevealGame,
  type RoundPhase,
  type SegmentId,
  type SubmissionRecord,
} from '@mt/protocol';
import { DbService } from './db.service.js';
import { LedgerService } from './ledger.service.js';
import { loadSessionConfig, toProgram, toTeams } from './config.js';
import { foldFinal } from './submissions.js';
import type { ActiveRound, SessionState } from './state.js';
import { buildGames } from '../games/registry.js';

const now = (): EpochMs => Date.now();

/** 사회자한테 돌아가는 거절 사유. 조용히 실패하면 눌렀는데 아무 일도 안 나고, 그게 8시 35분에 제일 나쁘다. */
type NavResult = { ok: true } | { ok: false; message: string };

/**
 * ═══ 세그먼트 러너 + 리빌 루프 ═══
 *
 * 단계 1의 리빌 루프 위에 단계 2가 세그먼트를 얹었다: 프로그램(config)의 꼭지를 갈아타고,
 * GAME 세그먼트 안에서 라운드 목록을 굴린다. ★코어가 게임의 kind로 분기하는 곳은
 * 여기뿐이다★ (game.ts) — 지금은 LOCK_REVEAL만 굴릴 줄 알고, Live 엔진은 단계 3이다.
 *
 * ★전이 규칙을 여기 다시 쓰지 않는다★ 전부 LEGAL_TRANSITIONS를 물어본다.
 * 표가 두 벌이 되면 어긋나고, 어긋난 걸 아는 시점은 8시 35분이다.
 */
@Injectable()
export class RoundService implements OnModuleDestroy {
  /** 스냅샷을 다시 쏴야 한다는 신호. 게이트웨이가 구독한다. */
  readonly changes$ = new Subject<void>();

  readonly state: SessionState;
  private readonly games: ReadonlyMap<GameId, Game>;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly ledger: LedgerService,
    db: DbService,
  ) {
    // ★던지면 Nest가 부팅에 실패한다. 그게 의도다★ — 설정이 틀렸으면 7:30에 알아야 한다.
    const cfg = loadSessionConfig();
    this.games = buildGames({ loadQuizQuestions: () => db.loadQuizQuestions() });

    const program = toProgram(cfg);
    // config는 game 문자열이 뭔지 모른다. 등록부 대조는 여기서만 할 수 있다.
    for (const seg of program) {
      if (seg.kind === 'GAME' && !this.games.has(seg.gameId!)) {
        throw new Error(
          `[config] 세그먼트 "${seg.segmentId}"가 없는 게임 "${seg.gameId}"를 가리킵니다. ` +
            `등록된 게임: ${[...this.games.keys()].join(', ')}`,
        );
      }
    }

    this.state = {
      sessionId: SessionId.parse(cfg.sessionId),
      teams: toTeams(cfg),
      roster: new Map(),
      entryOpen: true,
      program,
      segment: null, // bootstrap의 start()가 첫 세그먼트에 들어가며 채운다
      round: null,
      match: null, // Live 세그먼트에서 LIVE_ARM이 채운다 (live.service — 엔진이 유일한 작성자)
      blackout: false,
      stateSeq: 0,
    };

    // ★틱 하나로 자동 전이 둘을 굴린다★
    // 틱은 매번 현재 endsAt을 다시 읽는다. phase마다 setTimeout을 걸면 endsAt이 바뀔 때
    // 재스케줄을 잊는 버그가 생기는데, 여기엔 그게 존재할 수가 없다.
    //
    // ★10ms인 이유: 이 간격이 그대로 COUNTDOWN_ZERO의 지연 상한이다★
    // 빔은 소리와 숫자를 phaseEndsAt에서 로컬로 파생시키지만(정확), REVEAL 프레임이
    // 뜨는 건 이 틱이 결정한다. 50ms면 "0" 소리와 정답 화면이 눈에 띄게 어긋난다.
    // phase.ts: "3-2-1 다음에 프레임 단위로 정확히 착지해야 한다."
    this.timer = setInterval(() => this.tick(), 10);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * 부팅 마지막 단계. 첫 세그먼트에 들어가고, ★모든 GAME 세그먼트를 미리 적재해본다★
   *
   * 프리플라이트가 없으면 퀴즈 문제은행이 빈 걸 8:03의 SEGMENT_GOTO 거절로 처음 안다.
   * 지금 한 번씩 돌려보면 7:30에 안다 — 결과는 버린다 (진입 시 다시 적재. "적재 후 불변"은
   * 라운드 얘기지 세그먼트 재진입까지 금지하는 게 아니다).
   */
  async start(): Promise<void> {
    for (const seg of this.state.program) {
      if (seg.kind !== 'GAME') continue;
      const game = this.games.get(seg.gameId!)!;
      if (game.kind !== 'LOCK_REVEAL') {
        // Live는 적재할 라운드가 없다 — 상수 제정신 검사가 프리플라이트의 전부다.
        // 값이 계약이 아니라 게임 모듈에 살아서(anticheat.ts) 검사도 여기(부팅)가 맡는다.
        if (game.rate.burst <= game.rate.perSec) {
          throw new Error(`[preflight] "${seg.segmentId}" 레이트캡 이상 — burst(${game.rate.burst})는 perSec(${game.rate.perSec})보다 커야 한다. 아니면 순간 연타가 전부 치터로 잡힌다`);
        }
        if (game.durationMs <= 0) throw new Error(`[preflight] "${seg.segmentId}" durationMs가 0 이하`);
        console.log(`[preflight] ${seg.segmentId}: Live (${game.title}) OK — 상한 ${game.rate.perSec}/s·burst ${game.rate.burst}, ${game.durationMs / 1000}초`);
        continue;
      }
      const rounds = await game.loadRounds(this.loadCtx(seg.segmentId));
      if (rounds.length === 0) throw new Error(`[preflight] "${seg.segmentId}" 라운드 0개 — 문제은행을 확인하세요`);
      console.log(`[preflight] ${seg.segmentId}: ${rounds.length}라운드 OK`);
    }

    const first = this.state.program[0]!; // config가 min(1)을 보장한다
    const r = await this.gotoSegment(first.segmentId);
    if (!r.ok) throw new Error(`[boot] 첫 세그먼트 진입 실패 — ${r.message}`);
  }

  // ── 자동 전이 ──────────────────────────────────────────────
  /**
   * ★앱이 사회자 없이 넘어가는 전이는 이 둘뿐이다★ (phase.ts AutoTransition)
   * 여기에 세 번째를 추가하려면 AutoTransition enum에 멤버를 넣어야 하고,
   * verify.ts §4가 "정확히 2개"를 검사하므로 그 순간 빨간불이 켜진다.
   */
  private tick(): void {
    const r = this.state.round;
    if (!r || r.phaseEndsAt === null || now() < r.phaseEndsAt) return;

    if (r.phase === 'COLLECT') this.enter('LOCKED'); // COLLECT_DEADLINE
    else if (r.phase === 'COUNTDOWN') this.enter('REVEAL'); // COUNTDOWN_ZERO
  }

  // ── 세그먼트 이동 ──────────────────────────────────────────

  /**
   * ★이동은 라운드가 안 도는 동안만★ (IDLE·REACTION·ABORTED·없음)
   * COLLECT 한복판에 세그먼트를 갈아타면 커밋 안 된 제출이 조용히 증발한다 —
   * 버리는 건 ABORT의 일이고, 그건 시끄럽다(빔에 "무효"가 뜬다).
   */
  async gotoSegment(segmentId: SegmentId): Promise<NavResult> {
    if (!this.canNavigate()) return { ok: false, message: '라운드/매치 진행 중 — 먼저 커밋 또는 ABORT' };
    const def = this.state.program.find((s) => s.segmentId === segmentId);
    if (!def) return { ok: false, message: '프로그램에 없는 세그먼트' };

    // ★세그먼트를 떠나면 매치는 무조건 죽는다★ 남겨두면 다음 세그먼트의 빔에 지난 바가 뜬다.
    this.state.match = null;

    if (def.kind !== 'GAME') {
      this.state.segment = { def, game: null, rounds: [], cursor: 0 };
      this.state.round = null;
      this.bump();
      return { ok: true };
    }

    const game = this.games.get(def.gameId!)!; // 생성자에서 대조 완료

    if (game.kind === 'LIVE') {
      // Live는 라운드가 없다. 진입하면 세그먼트 표지(점수판)가 뜨고, 매치는 LIVE_ARM이 연다.
      this.state.segment = { def, game, rounds: [], cursor: 0 };
      this.state.round = null;
      this.bump();
      return { ok: true };
    }

    // ★게임당 1회. 문제은행 조회는 여기서 끝낸다★ (game.ts loadRounds)
    let rounds;
    try {
      rounds = await game.loadRounds(this.loadCtx(def.segmentId));
    } catch (e) {
      return { ok: false, message: `라운드 적재 실패 — ${(e as Error).message}` };
    }
    if (rounds.length === 0) return { ok: false, message: '라운드가 0개 — 문제은행 확인' };

    this.state.segment = { def, game, rounds, cursor: 0 };
    this.loadRoundAt(0);
    return { ok: true };
  }

  /** 라운드 스킵/점프. CLAUDE.md 콘솔 필수기능 "라운드 스킵"의 절반 (다른 절반은 ROUND_NEXT). */
  gotoRound(roundId: string): NavResult {
    const seg = this.state.segment;
    if (!seg?.game) return { ok: false, message: '게임 세그먼트가 아님' };
    if (!this.canNavigate()) return { ok: false, message: '라운드 진행 중 — 먼저 ABORT' };
    const i = seg.rounds.findIndex((r) => r.roundId === roundId);
    if (i < 0) return { ok: false, message: '이 세그먼트에 없는 라운드' };
    this.loadRoundAt(i);
    return { ok: true };
  }

  /** 커밋된 뒤에만. 마지막 라운드 다음은 세그먼트 표지(점수판) — 사회자 멘트 + 다음 세그먼트로 가는 구간. */
  next(): boolean {
    const r = this.state.round;
    const seg = this.state.segment;
    if (!r || !seg || !['REACTION', 'ABORTED'].includes(r.phase)) return false;

    const ahead = seg.cursor + 1;
    if (ahead < seg.rounds.length) {
      this.loadRoundAt(ahead);
    } else {
      seg.cursor = seg.rounds.length; // 소진 표시
      this.state.round = null;
      this.bump();
    }
    return true;
  }

  private canNavigate(): boolean {
    const r = this.state.round;
    const roundIdle = !r || ['IDLE', 'REACTION', 'ABORTED'].includes(r.phase);
    // 매치도 같은 규칙: 커밋됐거나 무효(VOID)인 ENDED만 떠날 수 있다.
    // 미커밋 실결과를 넘어가면 점수가 조용히 증발한다 — 버리려면 ABORT(폐기)가 명시적 경로다.
    const m = this.state.match;
    const matchIdle = !m || (m.phase === 'ENDED' && (m.committed || m.outcome?.kind === 'VOID'));
    return roundIdle && matchIdle;
  }

  private loadRoundAt(i: number): void {
    const seg = this.state.segment!;
    const game = seg.game as LockRevealGame<unknown>; // rounds가 차 있으면 LockReveal이다 (gotoSegment)
    const spec = seg.rounds[i]!;
    seg.cursor = i;
    this.state.round = {
      spec,
      gameId: game.gameId,
      scope: game.answerScope, // ★게임한테서 받는다. 코어가 정하지 않는다★
      phase: 'IDLE',
      phaseStartedAt: now(),
      phaseEndsAt: null,
      multiplier: 1, // ★다음 라운드 진입 시 자동 리셋★ (events.ts SET_MULTIPLIER)
      basePoints: spec.basePoints,
      log: [],
      scored: null,
    };
    this.bump();
  }

  private loadCtx(segmentId: SegmentId) {
    return { segmentId, teams: this.state.teams, roster: [...this.state.roster.values()] };
  }

  // ── 사회자 명령 (리빌 루프) ────────────────────────────────

  // 전부 "합법이었나"를 boolean으로 돌려준다. 콘솔이 거절 사유를 봐야 한다.
  present(): boolean { return this.enter('PROMPT'); }
  open(): boolean { return this.enter('COLLECT'); }
  lock(): boolean { return this.enter('LOCKED'); }
  countdown(): boolean { return this.enter('COUNTDOWN'); }
  abort(): boolean { return this.enter('ABORTED'); }

  setMultiplier(m: 1 | 2): boolean {
    const r = this.state.round;
    if (!r || r.phase === 'REACTION' || r.phase === 'ABORTED') return false;
    r.multiplier = m;
    this.bump();
    return true;
  }

  /** ★IDLE..COLLECT 에서만★ 답을 보고 배점을 튜닝하면 리깅이다 (events.ts SET_POINTS). */
  setPoints(basePoints: number): boolean {
    const r = this.state.round;
    if (!r || !['IDLE', 'PROMPT', 'COLLECT'].includes(r.phase)) return false;
    r.basePoints = basePoints;
    this.bump();
    return true;
  }

  setBlackout(on: boolean): void {
    this.state.blackout = on;
    this.bump();
  }

  closeEntry(): void {
    this.state.entryOpen = false;
    this.bump();
  }

  /**
   * ★커밋 지점. 여기서만 점수가 영속화된다★ (phase.ts REVEAL → REACTION)
   * 배수는 정확히 여기서 1회 읽고 RoundEntry에 동결된다.
   */
  commitScore(): boolean {
    const r = this.state.round;
    if (!r || r.phase !== 'REVEAL' || !r.scored) return false;

    const baseDeltas: Record<string, number> = {};
    const appliedDeltas: Record<string, number> = {};
    for (const [teamId, d] of r.scored.baseDeltas) {
      baseDeltas[teamId] = d;
      appliedDeltas[teamId] = d * r.multiplier;
    }

    this.ledger.append({
      kind: 'ROUND',
      sessionId: this.state.sessionId,
      at: now(),
      by: 'HOST',
      segmentId: r.spec.segmentId,
      roundId: r.spec.roundId,
      matchId: null,
      gameId: r.gameId,
      multiplier: r.multiplier,
      basePoints: r.basePoints,
      baseDeltas,
      appliedDeltas,
      // 개인 단위를 절대 안 버린다 — "OO이 나와봐"의 재료다.
      detail: { callouts: r.scored.callouts, log: r.log },
    });

    this.enter('REACTION');
    return true;
  }

  // ── 제출 ───────────────────────────────────────────────────

  /**
   * ★PHASE_CLOSED는 10.05초에 반드시 발생한다★ (events.ts SubmitAck)
   * 폰은 스피너 대신 "마감됐어요"를 띄워야 한다.
   */
  submit(pid: ParticipantId, roundId: string, raw: unknown):
    | { ok: true; at: EpochMs; accepted: unknown; by?: string }
    | { ok: false; reason: 'PHASE_CLOSED' | 'WRONG_ROUND' | 'NOT_IN_ROSTER' | 'INVALID'; message: string } {
    const r = this.state.round;
    const game = this.state.segment?.game;
    // kind 검사는 타입 좁히기다 — 라운드가 있으면 LockReveal이지만, 컴파일러는 그 불변식을 모른다.
    if (!r || !game || game.kind !== 'LOCK_REVEAL' || r.phase !== 'COLLECT') return { ok: false, reason: 'PHASE_CLOSED', message: '마감됐어요' };
    // 재접속한 폰이 옛날 화면 상태로 제출하는 건 실제로 일어난다.
    if (r.spec.roundId !== roundId) return { ok: false, reason: 'WRONG_ROUND', message: '지난 문제예요' };

    const person = this.state.roster.get(pid);
    if (!person) return { ok: false, reason: 'NOT_IN_ROSTER', message: '입장 정보가 없어요' };

    const parsed = game.parseAnswer(r.spec, raw);
    if (!parsed.ok) return { ok: false, reason: 'INVALID', message: parsed.message };

    /**
     * 잠금까진 덮어쓰기. ★이력은 남긴다★ — 번복 횟수가 리액션의 재료다.
     *
     * ★세는 단위가 scope를 따른다★ game.ts가 원하는 리액션은
     * "3조 최종 배신. 마지막에 누른 건 이영희. ★4번 번복함★"인데, 그 4번은 ★조가★ 뒤집은
     * 횟수다. 개인별로 세면 3명이 한 번씩 눌러도 전부 revision 0이라 번복이 0으로 보인다.
     */
    const prior =
      r.scope === 'TEAM'
        ? r.log.filter((x) => x.teamId === person.teamId).length
        : r.log.filter((x) => x.participantId === pid).length;
    const rec: SubmissionRecord<unknown> = {
      participantId: pid,
      teamId: person.teamId,
      value: parsed.value,
      at: now(),
      revision: prior,
    };
    r.log.push(rec);
    this.bump();
    // TEAM이면 "누가 우리 조 답을 정했나"가 폰에 뜬다 — 지금 제출한 본인이다.
    return { ok: true, at: rec.at, accepted: parsed.value, ...(r.scope === 'TEAM' ? { by: person.name } : {}) };
  }

  // ── 로스터 ─────────────────────────────────────────────────

  join(pid: ParticipantId, name: string, teamId: TeamId): void {
    this.state.roster.set(pid, { participantId: pid, teamId, name, connected: true, lastSeen: now() });
    this.bump();
  }

  setConnected(pid: ParticipantId, connected: boolean): void {
    const e = this.state.roster.get(pid);
    if (!e) return;
    this.state.roster.set(pid, { ...e, connected, lastSeen: now() });
    this.bump();
  }

  // ── 내부 ───────────────────────────────────────────────────

  /** ★전이는 전부 이 문을 지난다. 합법성 판단이 한 곳에만 있다★ */
  private enter(to: RoundPhase): boolean {
    const r = this.state.round;
    if (!r) return false;
    if (!LEGAL_TRANSITIONS[r.phase].includes(to)) return false;

    if (to === 'LOCKED') r.scored = this.runScore(r);

    r.phase = to;
    r.phaseStartedAt = now();
    // ★COLLECT / COUNTDOWN 에서만 타이머가 있다★ 나머진 null — 리빌 뒤엔 타이머가 없다.
    r.phaseEndsAt =
      to === 'COLLECT' ? now() + r.spec.collectMs
      : to === 'COUNTDOWN' ? now() + r.spec.countdownMs
      : null;

    this.bump();
    return true;
  }

  /**
   * ★잠금 시점에 제출을 접는다. 접는 키가 scope다★ (foldFinal — 접기 규칙은 submissions.ts 한 곳에)
   * game.ts: "log를 절대 안 버린다 — 팀 단위로 접더라도 개인 기록은 전량 남긴다."
   * 그래서 final은 파생물이고 log가 원본이다. 리액션의 "OO이 나와봐"는 log에서 나온다.
   */
  private runScore(r: ActiveRound) {
    const game = this.state.segment!.game as LockRevealGame<unknown>; // 라운드가 있으면 게임 세그먼트다
    const base = {
      log: r.log,
      roster: [...this.state.roster.values()],
      teams: this.state.teams,
    };

    if (r.scope === 'TEAM') {
      return game.score(r.spec, { ...base, scope: 'TEAM', final: foldFinal(r.log, (x) => x.teamId) });
    }
    return game.score(r.spec, { ...base, scope: 'PARTICIPANT', final: foldFinal(r.log, (x) => x.participantId) });
  }

  /** 상태 변경 공지. Live 엔진(live.service)도 match 슬롯을 바꾸고 이걸 부른다 — 그래서 public. */
  bump(): void {
    this.state.stateSeq++;
    this.changes$.next();
  }
}
