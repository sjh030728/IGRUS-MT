import type {
  ContentChunks,
  DisplayChunk,
  DisplayRoundView,
  DisplayState,
  EpochMs,
  HostSnapshot,
  MatchCard,
  Me,
  ParticipantId,
  PlaySnapshot,
  RoundPhase,
  Scoreboard,
  SubmissionRecord,
  TeamInfo,
} from '@mt/protocol';
import { LEGAL_TRANSITIONS } from '@mt/protocol';
import { foldFinal } from './submissions.js';
import type { ActiveMatch, ActiveRound, SessionState } from './state.js';

/**
 * ═══ 스냅샷 투영기 ═══
 *
 * ★순수 함수다. 여기서 상태를 바꾸지 마라★
 * 상태 하나를 받아서 역할별로 "지금 니 화면 전부"를 만든다.
 * events.ts: "전이가 일어나면 각 역할한테 통째로 보낸다. 재접속이 스냅샷 1발로 끝난다."
 *
 * ★이 파일이 CLAUDE.md "빔 뷰와 콘솔은 절대 같은 화면에 뜨면 안 된다"의 구현체다★
 * 정답(hostBrief)이 host 함수에만 있고 display 함수엔 들어갈 자리조차 없다.
 * 실수로 흘리려면 DisplayRoundView 타입에 필드를 추가해야 하고, 그럼 verify.ts §5가 잡는다.
 */

// ─────────────────────────────────────────────────────────────
// 빔
// ─────────────────────────────────────────────────────────────

/**
 * ★빔 모드는 세그먼트에서 파생된다. 콘솔이 못 정한다★ (decisions/0002)
 * blackout은 모드가 아니라 이 파생 위에 덮이는 오버라이드다 — 그래서 덮을 뿐 자리를 안 뺏고,
 * 끄면 아래 파생이 그대로 다시 보인다. 복원할 상태가 애초에 없다.
 */
export function projectDisplay(s: SessionState, board: Scoreboard): DisplayState {
  if (s.blackout) return { mode: 'BLACK' };

  // 파생 규칙: 세그먼트 kind가 모드다. AWARD → 시상, GAME에서 라운드가 돌면 ROUND,
  // 매치가 있으면 LIVE, 그 외 전부(SCOREBOARD 세그먼트, 라운드 소진 표지, Live의
  // 매치 사이, 부팅 찰나)는 점수판 표지.
  const seg = s.segment;
  if (seg?.def.kind === 'AWARD') return { mode: 'AWARD', scoreboard: board };

  // ★매치가 스냅샷에 통째로 실린다★ ACTIVE 한복판에 빔이 새로고침돼도 이 한 발로 복구된다.
  // 20Hz 프레임은 이 위의 pos만 덮는다 (display.ts LIVE 멤버).
  const m = s.match;
  if (m) {
    return {
      mode: 'LIVE',
      scoreboard: board,
      card: cardOf(m),
      phase: m.phase,
      phaseStartedAt: m.phaseStartedAt,
      phaseEndsAt: m.phaseEndsAt,
      pos: m.pos,
      outcome: m.phase === 'ENDED' ? m.outcome : null,
    };
  }

  if (!s.round) {
    return { mode: 'SCOREBOARD_FULL', title: seg?.def.title ?? '준비 중', scoreboard: board };
  }
  // ★미터의 분모가 scope를 따른다★ 퀴즈는 40명이 각자 내고(37/40), 배신 라운드는
  // 조가 낸다(5/6 조). 로스터 크기를 항상 쓰면 배신에서 "3/40"이 떠서 다 안 낸 것처럼 보인다.
  const denom = s.round.scope === 'TEAM' ? s.teams.length : s.roster.size;
  return { mode: 'ROUND', scoreboard: board, round: roundView(s.round, denom) };
}

function roundView(r: ActiveRound, denom: number): DisplayRoundView {
  return {
    phase: r.phase,
    segmentId: r.spec.segmentId,
    roundId: r.spec.roundId,
    phaseStartedAt: r.phaseStartedAt,
    phaseEndsAt: r.phaseEndsAt,
    segmentTitle: r.spec.displayPrompt.title,
    index: r.spec.index,
    total: r.spec.total,
    multiplier: r.multiplier,
    content: contentFor(r, denom),
    // ★REACTION 에서만 non-null★ 그 전엔 절대 안 내려간다 — 사전 유출 방지.
    deltas: r.phase === 'REACTION' ? appliedDeltas(r) : null,
  };
}

/**
 * phase → 빔에 뜰 청크. ★예산은 3이다★ (display.ts MAX_CONTENT_CHUNKS)
 * 점수판이 하나를 먹고 시작하므로 화면 총합이 4가 된다.
 */
function contentFor(r: ActiveRound, denom: number): ContentChunks {
  const prompt = r.spec.displayPrompt.content;

  switch (r.phase) {
    // 사회자 멘트 구간. 빔엔 "문제 1 / 8" + 점수판뿐 (phase.ts IDLE).
    case 'IDLE':
      return [{ t: 'caption', text: `문제 ${r.spec.index} / ${r.spec.total}` }];

    // 사회자가 문제를 읽는다. 입력은 아직 닫혀 있다.
    case 'PROMPT':
      return prompt;

    // ★미터가 여기 있는 게 사망구간 해법이다★
    // display.ts: "37/40이 사회자의 '3조 아직도 안 냈어!'를 가능하게 한다."
    case 'COLLECT': {
      const meter: DisplayChunk = {
        t: 'meter',
        endsAt: r.phaseEndsAt ?? r.phaseStartedAt,
        got: submitterCount(r),
        // ContentChunks가 of: positive를 요구하므로 0명이어도 1로 깐다.
        of: Math.max(1, denom),
      };
      return clamp([...prompt, meter]);
    }

    // 잠금. 미터를 뗀다 — 더 낼 수 없는데 타이머가 남아 있으면 거짓말이다.
    case 'LOCKED':
      return prompt;

    // 두구두구. 거대 숫자가 화면을 먹으므로 문제는 한 줄로 줄인다.
    case 'COUNTDOWN': {
      const head = prompt.find((c) => c.t === 'headline');
      const big: DisplayChunk = { t: 'bignum', n: 0 }; // n은 빔이 phaseEndsAt에서 파생한다
      return clamp(head ? [head, big] : [big]);
    }

    // ★동시 공개★ 게임이 낸 리빌 청크를 그대로 건다. 코어는 안을 안 본다.
    case 'REVEAL':
    case 'REACTION':
      return r.scored?.reveal ?? [];

    case 'ABORTED':
      return [{ t: 'caption', text: '무효' }];
  }
}

function clamp(chunks: DisplayChunk[]): ContentChunks {
  return chunks.slice(0, 3);
}

/** 매치의 고정 정보. ARM 이후 절대 안 변한다 — 변하는 건 pos·phase뿐. */
function cardOf(m: ActiveMatch): MatchCard {
  return { matchId: m.matchId, a: m.spec.a, b: m.spec.b, basePoints: m.spec.basePoints, durationMs: m.durationMs };
}

/** 분자도 scope를 따른다. 조가 답하는 라운드에서 3명이 눌렀어도 그건 1조다. */
function submitterCount(r: ActiveRound): number {
  return new Set(r.log.map((x) => (r.scope === 'TEAM' ? x.teamId : x.participantId))).size;
}

function appliedDeltas(r: ActiveRound): Record<string, number> {
  const out: Record<string, number> = {};
  if (!r.scored) return out;
  for (const [teamId, d] of r.scored.baseDeltas) out[teamId] = d * r.multiplier;
  return out;
}

// ─────────────────────────────────────────────────────────────
// 콘솔
// ─────────────────────────────────────────────────────────────

export function projectHost(
  s: SessionState,
  board: Scoreboard,
  totals: Record<string, number>,
  ledgerTail: HostSnapshot['ledgerTail'],
  now: EpochMs,
  health: HostSnapshot['health'],
): HostSnapshot {
  const r = s.round;
  return {
    serverNow: now,
    // 빔에 지금 뭐가 떠 있는지 미리보기. 확장 모드라 사회자한텐 빔이 안 보인다.
    display: projectDisplay(s, board),
    // ★정답★ DisplayState엔 이 필드가 아예 없다.
    brief: r ? { answerText: r.spec.hostBrief.answerText, ...(r.spec.hostBrief.patter !== undefined ? { patter: r.spec.hostBrief.patter } : {}) } : null,
    // SET_POINTS 입력칸 옆에 뜨는 현재 배점 — 얼마 걸려 있는지 모르면 배점 조정이 도박이다.
    basePoints: r ? r.basePoints : null,
    submissions: r
      ? r.log.map((x) => ({
          participantId: x.participantId,
          name: s.roster.get(x.participantId)?.name ?? '?',
          teamId: x.teamId,
          value: x.value,
          at: x.at,
          revision: x.revision,
        }))
      : [],
    roster: [...s.roster.values()],
    ledgerTail,
    totals,
    // ★서버가 전이표에서 파생해서 내려준다 → 콘솔이 상태머신을 재구현하지 않는다★
    legal: legalCommands(s),
    program: s.program.map((d) => ({
      segmentId: d.segmentId,
      title: d.title,
      kind: d.kind,
      gameId: d.gameId,
      current: s.segment?.def.segmentId === d.segmentId,
    })),
    segmentRounds: (s.segment?.rounds ?? []).map((spec) => ({ roundId: spec.roundId, index: spec.index })),
    // 라운드의 brief/basePoints와 같은 대칭 — 블랙아웃 중에도 콘솔은 매치를 봐야 한다 (events.ts).
    live: s.match
      ? {
          phase: s.match.phase,
          phaseStartedAt: s.match.phaseStartedAt,
          phaseEndsAt: s.match.phaseEndsAt,
          card: cardOf(s.match),
          outcome: s.match.phase === 'ENDED' ? s.match.outcome : null,
          committed: s.match.committed,
        }
      : null,
    health,
  };
}

/**
 * 지금 누를 수 있는 명령. 콘솔은 이걸로 버튼을 disable한다.
 * ★전이표(LEGAL_TRANSITIONS)에서 파생한다 — 여기에 규칙을 다시 쓰지 마라★
 * 두 벌이 되는 순간 어긋나고, 어긋난 걸 아는 시점은 8시 35분이다.
 */
export function legalCommands(s: SessionState): string[] {
  const out: string[] = ['DISPLAY_BLACKOUT'];
  if (s.entryOpen) out.push('CLOSE_ENTRY');

  const r = s.round;
  const m = s.match;
  const matchIdle = !m || (m.phase === 'ENDED' && (m.committed || m.outcome?.kind === 'VOID'));

  // ★이동은 라운드/매치가 안 도는 동안만★ (round.service canNavigate와 같은 규칙 —
  // 여기는 버튼 표시용 파생일 뿐, 진짜 거절은 서버 메서드가 한다)
  if ((!r || ['IDLE', 'REACTION', 'ABORTED'].includes(r.phase)) && matchIdle) {
    out.push('SEGMENT_GOTO');
    if (s.segment?.game?.kind === 'LOCK_REVEAL') out.push('ROUND_GOTO');
  }

  // ── Live — 전이표(LEGAL_LIVE_TRANSITIONS)의 사회자 몫 + arm/커밋 규칙의 파생 ──
  if (s.segment?.game?.kind === 'LIVE') {
    if (matchIdle) out.push('LIVE_ARM');
    if (m?.phase === 'ARMED') out.push('LIVE_START');
    // ABORT: 도는 매치 어디서든 + 미커밋 ENDED(폐기). 커밋된 매치는 무를 게 없다 — VOID(원장)가 길이다.
    if (m && (m.phase !== 'ENDED' || !m.committed)) out.push('LIVE_ABORT');
    if (m?.phase === 'ENDED' && !m.committed && m.outcome && m.outcome.kind !== 'VOID') out.push('LIVE_COMMIT');
  }

  if (!r) return out;

  const can = (to: RoundPhase) => LEGAL_TRANSITIONS[r.phase].includes(to);

  if (can('PROMPT')) out.push('ROUND_PRESENT');
  if (can('COLLECT')) out.push('ROUND_OPEN');
  if (can('LOCKED')) out.push('ROUND_LOCK');
  if (can('COUNTDOWN')) out.push('ROUND_COUNTDOWN');
  if (can('ABORTED')) out.push('ROUND_ABORT');
  // ★REVEAL → REACTION 이 유일한 커밋 지점★
  if (r.phase === 'REVEAL') out.push('ROUND_SCORE');
  // 커밋된 뒤에만 다음으로. 리액션은 사회자가 끊을 때까지 안 넘어간다.
  if (r.phase === 'REACTION' || r.phase === 'ABORTED') out.push('ROUND_NEXT');

  // events.ts: 배수는 IDLE..REVEAL, 배점은 IDLE..COLLECT 에서만 합법.
  if (!['REACTION', 'ABORTED'].includes(r.phase)) out.push('SET_MULTIPLIER');
  if (['IDLE', 'PROMPT', 'COLLECT'].includes(r.phase)) out.push('SET_POINTS');

  return out;
}

// ─────────────────────────────────────────────────────────────
// 폰
// ─────────────────────────────────────────────────────────────

/**
 * ★HEADS_UP이 이 계약에서 제일 중요한 뷰다★ (events.ts)
 * 리빌 순간 폰을 죽인다. 폰이 정답을 띄우면 40명이 고개를 박고 빔이 장식이 된다.
 */
export function projectPlay(s: SessionState, me: Me, pid: ParticipantId): PlaySnapshot {
  // ── 매치가 돌면 라운드보다 먼저다 (둘이 공존할 수 없지만, 분기 순서는 명시해 둔다) ──
  const m = s.match;
  if (m) {
    if (m.phase === 'ENDED') return { view: 'WAIT', me, message: '결과는 화면에!' };
    // ★대표 3명만 eligible★ 나머지 37명은 응원 화면 — 그 37명이 오디오다 (live.ts).
    const eligible = m.spec.a.eligible.includes(pid) || m.spec.b.eligible.includes(pid);
    return { view: 'TAP', me, matchId: m.matchId, eligible, phase: m.phase, phaseEndsAt: m.phaseEndsAt };
  }

  const r = s.round;

  if (!r) {
    return s.entryOpen
      ? { view: 'LOBBY', me, teams: teamsWithMembers(s) }
      : { view: 'WAIT', me, message: '곧 시작합니다' };
  }

  switch (r.phase) {
    case 'IDLE':
    case 'PROMPT':
      return { view: 'WAIT', me, message: '화면을 보세요' };

    case 'COLLECT': {
      const mine = mineOf(s, r, me, pid);
      return {
        view: 'INPUT',
        me,
        roundId: r.spec.roundId,
        // 폰이 "내 답"인지 "우리 조 답"인지 알아야 UI 문구가 갈린다.
        scope: r.scope,
        // ★문제 본문은 안 온다★ — 빔을 보게 하려고. (이제 어휘가 막는다 — play.ts)
        prompt: r.spec.playPrompt,
        endsAt: r.phaseEndsAt ?? r.phaseStartedAt,
        mine,
      };
    }

    // 잠금~공개. 폰은 죽는다.
    case 'LOCKED':
    case 'COUNTDOWN':
    case 'REVEAL': {
      const mine = mineOf(s, r, me, pid);
      // 값이 아니라 ★라벨★을 준다 — HEADS_UP은 표시 전용이라 'BETRAY'가 아니라 '🔪 배신'이 떠야 한다.
      // (INPUT.mine은 값 그대로다 — 폰이 눌린 버튼을 찾는 키로 쓴다.)
      return { view: 'HEADS_UP', me, scope: r.scope, mine: mine ? labelOf(r, mine.value) : null };
    }

    // 그땐 어차피 고개를 숙인다. "야 나 맞았어"가 오디오다.
    case 'REACTION': {
      const delta = r.scored ? (r.scored.baseDeltas.get(me.teamId) ?? 0) * r.multiplier : 0;
      return { view: 'RESULT', me, correct: null, teamDelta: delta };
    }

    case 'ABORTED':
      return { view: 'WAIT', me, message: '이 문제는 무효입니다' };
  }
}

/**
 * ★조원은 설정이 아니라 로스터에서 파생된다★
 * 조당 인원을 설정에 적어두면 실제로 누가 들어왔는지와 어긋난다 — 물놀이 후 8시엔 반드시
 * 어긋난다. 매 스냅샷 로스터에서 다시 만든다.
 *
 * 이게 폰 로비의 "1조 (5명)"을 가능하게 하고, 그게 없으면 40명이 한 조로 몰려도 아무도 모른다.
 */
function teamsWithMembers(s: SessionState): TeamInfo[] {
  return s.teams.map((t) => ({
    ...t,
    memberIds: [...s.roster.values()].filter((p) => p.teamId === t.teamId).map((p) => p.participantId),
  }));
}

/**
 * 폰에 뜨는 "지금 답". ★scope가 주어를 바꾼다★
 * PARTICIPANT: 내가 마지막으로 낸 것. TEAM: ★우리 조★의 현재 답 — 내가 안 냈어도
 * 조원이 냈으면 차 있고, by가 그 작성자다. 이게 없으면 배신 라운드의 폰이
 * "내 제출: 협력"을 띄우는 동안 조 답은 배신으로 덮여 있는, 적극적으로 틀린 화면이 된다.
 * 접기 규칙은 잠금 채점과 같은 foldFinal 한 곳이다 (submissions.ts).
 */
/** 답 값 → 폰 라벨. 게임이 어휘(playPrompt)에 이미 적어놨다 — 여기서 새 표를 만들지 않는다. */
function labelOf(r: ActiveRound, value: unknown): string {
  const item = r.spec.playPrompt.items.find((it) => it.value === value);
  return item?.label ?? String(value);
}

function mineOf(
  s: SessionState,
  r: ActiveRound,
  me: Me,
  pid: ParticipantId,
): { value: unknown; at: EpochMs; by?: string } | null {
  const rec: SubmissionRecord<unknown> | undefined =
    r.scope === 'TEAM'
      ? foldFinal(r.log, (x) => x.teamId).get(me.teamId)
      : foldFinal(r.log, (x) => x.participantId).get(pid);
  if (!rec) return null;
  if (r.scope !== 'TEAM') return { value: rec.value, at: rec.at };
  return { value: rec.value, at: rec.at, by: s.roster.get(rec.participantId)?.name ?? '?' };
}
