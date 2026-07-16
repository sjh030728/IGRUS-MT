import { z } from 'zod';
import {
  GameId,
  RoundId,
  type Callout,
  type ContentChunks,
  type LockRevealGame,
  type ParseResult,
  type RoundSpec,
  type ScoreResult,
  type SubmissionRecord,
  type TeamId,
  type Tone,
} from '@mt/protocol';

/**
 * ═══ 배신 라운드 ═══ 8:31 피크 2차. "야유 + 역전 비명" (program-ops.md)
 *
 * ★TEAM scope의 첫 소비자다★ — 단계 2가 퀴즈가 아니라 여기서 시작하는 이유.
 * 미터 분모 분기 · TEAM 채점 · 조 단위 번복이 전부 이 파일 때문에 처음 돈다.
 *
 * 룰 (사회자가 한 호흡에 설명할 수 있어야 한다 — 방전 상태에 2분 룰 설명은 사망):
 *   "조마다 몰래 고르세요. 전원 협력이면 다 같이 +P.
 *    누가 배신하면 배신한 조만 +2P, 협력한 조는 −P. 근데 전원 배신이면 다 같이 −P."
 *
 * 죄수의 딜레마 표준형이 아니라 공유지형(all-play-all)인 이유: 조가 2~6개라 짝짓기가
 * 안 나오고, "우리 빼고 다 배신했대"가 방 전체의 사건이 된다 — 리액션이 조 단위가 아니라
 * 방 단위로 터진다.
 *
 * ★무응답 조는 협력 취급★ 배터리 전멸(위험 3위)로 조가 통째로 못 낸 게 감점이면 사고다.
 * "가만히 있으면 협력"은 룰 설명도 공짜다 — 움직인 조만 책임진다.
 */

/** 와이어와 원장 detail에 실리는 값. 라벨(한글)과 분리 — 라벨은 연출, 값은 계약이다. */
const Answer = z.enum(['COOP', 'BETRAY']);
type Answer = z.infer<typeof Answer>;

const LABEL: Record<Answer, string> = { COOP: '협력', BETRAY: '배신' };
const TONE_OF: Record<Answer, Tone> = { COOP: 'GOOD', BETRAY: 'BAD' };

/**
 * 3라운드 에스컬레이션. 1라운드는 룰 학습(다들 협력하고 안심), 2라운드부터 칼이 나온다.
 * 배점이 뒤로 갈수록 커서 "마지막 판 한 방"이 산다 — 그래도 모자라면 ×2 토글이 헤일메리.
 *
 * ★기본값일 뿐이다★ CLAUDE.md: "2~3위가 1위를 뒤집되 5~6위는 못 뒤집는 수준. 낮 점수
 * 실측을 보고 SET_POINTS로 맞춘다." 그 실측은 8:30에야 나온다 — 여기 숫자에 목숨 걸지 마라.
 */
const ROUND_POINTS = [300, 400, 500] as const;

const COLLECT_MS = 30_000; // "아니 잠깐 바꿔! 협력으로!"가 터질 시간. 퀴즈(10초)보다 길다.
const COUNTDOWN_MS = 5_000; // 두구두구도 길다 — 이 공개가 이 게임의 전부라서.

export const betrayalGame: LockRevealGame<Answer> = {
  gameId: GameId.parse('betrayal'),
  kind: 'LOCK_REVEAL',
  title: '배신 라운드',
  answerScope: 'TEAM',

  /** DB 없음 — 문항이 아니라 룰이 콘텐츠다. 결정적: 항상 같은 3라운드. */
  async loadRounds(ctx): Promise<readonly RoundSpec[]> {
    return ROUND_POINTS.map((points, i): RoundSpec => ({
      roundId: RoundId.parse(`betrayal-r${i + 1}`),
      segmentId: ctx.segmentId,
      index: i + 1,
      total: ROUND_POINTS.length,
      displayPrompt: {
        title: '배신 라운드',
        content: [
          { t: 'headline', text: '협력이냐, 배신이냐' },
          {
            t: 'caption',
            text: `전원 협력 +${points} · 배신 조 +${points * 2} 협력 조 −${points} · 전원 배신 −${points}`,
          },
        ],
      },
      playPrompt: {
        kind: 'choices',
        items: [
          { value: 'COOP', label: '🤝 협력', tone: 'GOOD' },
          { value: 'BETRAY', label: '🔪 배신', tone: 'BAD' },
        ],
      },
      hostBrief: {
        // 정답이 없는 게임이라 이 칸엔 룰 요약이 간다. 콘솔 제출 로그가 실시간 정답지다.
        answerText: `전원협력 전조 +${points} / 배신 +${points * 2}·협력 −${points} / 전원배신 전조 −${points}`,
        patter:
          i === 0
            ? '1판은 다들 협력하고 안심하는 판. "거 봐 착하네" 하고 넘어갈 것'
            : '무응답 조는 협력 처리. 제출 로그에서 번복 전쟁이 보인다 — 마지막에 누른 사람을 불러라',
      },
      basePoints: points,
      collectMs: COLLECT_MS,
      countdownMs: COUNTDOWN_MS,
    }));
  },

  /** ★unknown → ParseResult<T>. 이 경계가 검증이 사는 유일한 지점이다★ */
  parseAnswer(_round, raw): ParseResult<Answer> {
    const r = Answer.safeParse(raw);
    if (!r.success) return { ok: false, reason: 'INVALID', message: '협력 또는 배신 중에 고르세요' };
    return { ok: true, value: r.data };
  },

  /** LOCKED 진입 시 1회. 순수 + 결정적. ★배수를 보지 못한다 — 코어가 곱한다★ */
  score(round, bag): ScoreResult {
    const P = round.basePoints;

    // 조별 최종 선택. ★무응답 → 협력★ (파일 상단)
    const choice = new Map<TeamId, Answer>();
    for (const t of bag.teams) {
      const final = bag.scope === 'TEAM' ? bag.final.get(t.teamId) : undefined;
      choice.set(t.teamId, final?.value ?? 'COOP');
    }
    const betrayed = [...choice.values()].filter((v) => v === 'BETRAY').length;
    const everyone = bag.teams.length;

    const deltaOf = (v: Answer): number =>
      betrayed === 0 ? P : betrayed === everyone ? -P : v === 'BETRAY' ? P * 2 : -P;

    const baseDeltas = new Map<TeamId, number>();
    for (const t of bag.teams) baseDeltas.set(t.teamId, deltaOf(choice.get(t.teamId)!));

    // ★동시 공개 한 프레임★ — 조별 순차 플립 금지. 격자가 그 프레임이다.
    const headline =
      betrayed === 0 ? '전원 협력 🤝' : betrayed === everyone ? '전원 배신 💀' : `배신 ${betrayed}!`;
    const reveal: ContentChunks = [
      { t: 'headline', text: headline },
      {
        t: 'grid',
        cells: bag.teams.map((t) => {
          const v = choice.get(t.teamId)!;
          return { label: t.name, value: LABEL[v], tone: TONE_OF[v] };
        }),
      },
    ];

    // ★리액션의 재료★ "3조 최종 배신. 마지막에 누른 건 이영희. 4번 번복함" (game.ts TEAM 주석)
    const callouts: Callout[] = bag.teams.map((t) => {
      const mine = bag.log.filter((x) => x.teamId === t.teamId);
      const final = mine[mine.length - 1];
      if (!final) {
        return { kind: 'NO_SUBMIT', teamId: t.teamId, label: `${t.name} — 무응답 (협력 처리)` };
      }
      const lastName = bag.roster.find((p) => p.participantId === final.participantId)?.name ?? '?';
      const flips = countFlips(mine);
      return {
        kind: 'NOTABLE',
        teamId: t.teamId,
        participantId: final.participantId,
        label: `${t.name} ${LABEL[final.value as Answer]} — 마지막에 누른 건 ${lastName}`,
        ...(flips > 0 ? { note: `${flipPath(mine)} (${flips}번 번복)` } : {}),
      };
    });

    return { baseDeltas, reveal, callouts };
  },
};

/** 번복 횟수 = 조의 답이 ★값이 바뀐★ 횟수. 같은 값 연타는 번복이 아니다. */
function countFlips(log: readonly SubmissionRecord<unknown>[]): number {
  let flips = 0;
  for (let i = 1; i < log.length; i++) if (log[i]!.value !== log[i - 1]!.value) flips++;
  return flips;
}

/** "협력→배신→협력". 너무 길면 사회자가 못 읽으니 마지막 5개 변곡만. */
function flipPath(log: readonly SubmissionRecord<unknown>[]): string {
  const path: string[] = [];
  for (const x of log) {
    const label = LABEL[x.value as Answer];
    if (path[path.length - 1] !== label) path.push(label);
  }
  const tail = path.slice(-5);
  return (path.length > 5 ? '…' : '') + tail.join('→');
}
