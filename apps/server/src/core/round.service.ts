import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Subject } from 'rxjs';
import {
  LEGAL_TRANSITIONS,
  ParticipantId,
  SegmentId,
  SessionId,
  TeamId,
  type EpochMs,
  type LockRevealGame,
  type RoundPhase,
  type SubmissionBag,
  type SubmissionRecord,
} from '@mt/protocol';
import { LedgerService } from './ledger.service.js';
import { loadSessionConfig, toTeams } from './config.js';
import type { ActiveRound, SessionState } from './state.js';
import { dummyGame } from '../games/dummy.game.js';

const now = (): EpochMs => Date.now();

/**
 * ═══ 리빌 루프 ═══ 단계 1의 본체.
 *
 * CLAUDE.md 원칙 1: "잠금 → 카운트다운 → 동시 공개 → 점수 애니메이션. 이 시퀀스가 코어다."
 *
 * ★전이 규칙을 여기 다시 쓰지 않는다★ 전부 LEGAL_TRANSITIONS를 물어본다.
 * 표가 두 벌이 되면 어긋나고, 어긋난 걸 아는 시점은 8시 35분이다.
 */
@Injectable()
export class RoundService implements OnModuleDestroy {
  /** 스냅샷을 다시 쏴야 한다는 신호. 게이트웨이가 구독한다. */
  readonly changes$ = new Subject<void>();

  readonly state: SessionState;
  private readonly game: LockRevealGame<unknown, unknown> = dummyGame as LockRevealGame<unknown, unknown>;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly ledger: LedgerService) {
    // ★던지면 Nest가 부팅에 실패한다. 그게 의도다★ — 설정이 틀렸으면 7:30에 알아야 한다.
    const cfg = loadSessionConfig();
    this.state = {
      sessionId: SessionId.parse(cfg.sessionId),
      teams: toTeams(cfg),
      roster: new Map(),
      entryOpen: true,
      segmentId: SegmentId.parse('seg-dummy'),
      segmentTitle: cfg.title,
      round: null,
      blackout: false,
      stateSeq: 0,
    };

    // ★틱 하나로 자동 전이 둘을 굴린다★
    // setTimeout을 phase마다 걸면 ROUND_EXTEND가 endsAt을 밀 때 재스케줄을 잊는다.
    // 틱은 매번 현재 endsAt을 다시 읽으므로 그 버그가 존재할 수 없다.
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

  // ── 사회자 명령 ────────────────────────────────────────────

  async loadDummyRound(): Promise<void> {
    const rounds = await this.game.loadRounds({
      segmentId: this.state.segmentId,
      teams: this.state.teams,
      roster: [...this.state.roster.values()],
    });
    const spec = rounds[0];
    if (!spec) throw new Error('더미 라운드가 비어 있다');

    this.state.round = {
      spec,
      gameId: this.game.gameId,
      scope: this.game.answerScope, // ★게임한테서 받는다. 코어가 정하지 않는다★
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

  // 전부 "합법이었나"를 boolean으로 돌려준다. 콘솔이 거절 사유를 봐야 한다 —
  // 조용히 실패하면 사회자가 눌렀는데 아무 일도 안 나고, 그게 8시 35분에 제일 나쁘다.
  present(): boolean { return this.enter('PROMPT'); }
  open(): boolean { return this.enter('COLLECT'); }
  lock(): boolean { return this.enter('LOCKED'); }
  countdown(): boolean { return this.enter('COUNTDOWN'); }
  abort(): boolean { return this.enter('ABORTED'); }

  /** "5초 더!" — COLLECT 에서만. 틱이 새 endsAt을 자동으로 읽는다. */
  extend(addMs: number): boolean {
    const r = this.state.round;
    if (!r || r.phase !== 'COLLECT' || r.phaseEndsAt === null) return false;
    r.phaseEndsAt = r.phaseEndsAt + addMs;
    this.bump();
    return true;
  }

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

  /** 커밋된 뒤에만. 다음 라운드는 새 라운드의 IDLE이다. */
  async next(): Promise<void> {
    const r = this.state.round;
    if (!r || !['REACTION', 'ABORTED'].includes(r.phase)) return;
    this.state.round = null;
    this.bump();
  }

  // ── 제출 ───────────────────────────────────────────────────

  /**
   * ★PHASE_CLOSED는 10.05초에 반드시 발생한다★ (events.ts SubmitAck)
   * 폰은 스피너 대신 "마감됐어요"를 띄워야 한다.
   */
  submit(pid: ParticipantId, roundId: string, raw: unknown):
    | { ok: true; at: EpochMs; accepted: unknown }
    | { ok: false; reason: 'PHASE_CLOSED' | 'WRONG_ROUND' | 'NOT_IN_ROSTER' | 'INVALID'; message: string } {
    const r = this.state.round;
    if (!r || r.phase !== 'COLLECT') return { ok: false, reason: 'PHASE_CLOSED', message: '마감됐어요' };
    // 재접속한 폰이 옛날 화면 상태로 제출하는 건 실제로 일어난다.
    if (r.spec.roundId !== roundId) return { ok: false, reason: 'WRONG_ROUND', message: '지난 문제예요' };

    const person = this.state.roster.get(pid);
    if (!person) return { ok: false, reason: 'NOT_IN_ROSTER', message: '입장 정보가 없어요' };

    const parsed = this.game.parseAnswer(r.spec, raw);
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
    return { ok: true, at: rec.at, accepted: parsed.value };
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
   * ★잠금 시점에 제출을 접는다. 접는 키가 scope다★
   * game.ts: "log를 절대 안 버린다 — 팀 단위로 접더라도 개인 기록은 전량 남긴다."
   * 그래서 final은 파생물이고 log가 원본이다. 리액션의 "OO이 나와봐"는 log에서 나온다.
   */
  private runScore(r: ActiveRound) {
    const base = {
      log: r.log,
      roster: [...this.state.roster.values()],
      teams: this.state.teams,
    };

    if (r.scope === 'TEAM') {
      // ★조장도 다수결도 아니다. 아무 조원이나 누르되 잠금까지 덮어쓰기★ (game.ts)
      // 그래서 조별 "마지막에 누른 것"이 이긴다. 개인 revision이 아니라 시각으로 정렬한다 —
      // 번복은 조 단위 사건이고 누가 눌렀는지는 서로 다를 수 있다.
      const final = new Map<TeamId, SubmissionRecord<unknown>>();
      for (const x of r.log) {
        const prev = final.get(x.teamId);
        if (!prev || x.at >= prev.at) final.set(x.teamId, x);
      }
      return this.game.score(r.spec, { ...base, scope: 'TEAM', final } satisfies SubmissionBag<unknown>);
    }

    const final = new Map<ParticipantId, SubmissionRecord<unknown>>();
    for (const x of r.log) {
      const prev = final.get(x.participantId);
      if (!prev || x.revision >= prev.revision) final.set(x.participantId, x);
    }
    return this.game.score(r.spec, { ...base, scope: 'PARTICIPANT', final } satisfies SubmissionBag<unknown>);
  }

  private bump(): void {
    this.state.stateSeq++;
    this.changes$.next();
  }
}

