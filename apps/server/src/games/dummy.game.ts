import { z } from 'zod';
import {
  GameId,
  RoundId,
  type ContentChunks,
  type Callout,
  type LockRevealGame,
  type ParseResult,
  type RoundSpec,
  type ScoreResult,
  type SubmissionBag,
  type TeamId,
} from '@mt/protocol';

/**
 * ═══ 단계 1 더미. ★게임이 아니다★ ═══
 *
 * CLAUDE.md: "단계 1에 게임이 0개인 건 의도된 것이다. 더미 문제로 리빌 연출부터 완성한다."
 * 단계 2에서 진짜 게임(내부 퀴즈)이 들어오면 이 파일은 지운다.
 *
 * ★그런데 왜 LockRevealGame을 구현하나 — 인라인으로 채점하면 안 되나★
 * 안 된다. CLAUDE.md "레이어로 짠다, 게임으로 짜지 않는다":
 * 코어에 채점을 박아넣으면 단계 2에서 코어를 다시 짜게 되고, 그게 정확히 문서가 막으라는
 * "코드가 두 벌 나온다"다. 더미는 계약의 첫 소비자이고, ★그게 단계 1의 진짜 산출물이다★ —
 * 실제로 이 파일을 쓰는 과정에서 계약 버그 2개(ScoreResult.reveal, Game 유니온)가 나왔다.
 *
 * 길이도 계약의 지표다. 문서: "게임 하나가 30~50줄이면 계약이 제자리에 있는 것이고,
 * 200줄이면 뭔가 잘못된 것이다."
 */

const CHOICES = ['A', 'B', 'C', 'D'] as const;
const ANSWER = 'B';

export type DummyPrompt = { choices: readonly string[] };
export type DummyAnswer = (typeof CHOICES)[number];

const AnswerSchema = z.enum(CHOICES);

export const dummyGame: LockRevealGame<DummyPrompt, DummyAnswer> = {
  gameId: GameId.parse('dummy'),
  kind: 'LOCK_REVEAL',
  title: '더미 문제',
  answerScope: 'PARTICIPANT',

  async loadRounds(ctx): Promise<readonly RoundSpec<DummyPrompt>[]> {
    return [
      {
        roundId: RoundId.parse('dummy-r1'),
        segmentId: ctx.segmentId,
        index: 1,
        total: 1,
        displayPrompt: {
          title: '리빌 루프 점검',
          content: [
            { t: 'headline', text: '이 앱의 성공 기준은?' },
            {
              t: 'choices',
              items: [
                { label: 'A. 게임이 많은 것', tone: 'NEUTRAL' },
                { label: 'B. 오디오가 비지 않는 것', tone: 'NEUTRAL' },
                { label: 'C. 버그가 없는 것', tone: 'NEUTRAL' },
                { label: 'D. 점수가 정확한 것', tone: 'NEUTRAL' },
              ],
            },
          ],
        },
        playPrompt: { choices: CHOICES },
        hostBrief: {
          answerText: 'B — 오디오가 비지 않는 것',
          patter: '이거 틀리면 CLAUDE.md 안 읽은 겁니다',
        },
        basePoints: 100,
        collectMs: 10_000,
        countdownMs: 3_000,
      },
    ];
  },

  /** ★unknown → ParseResult<T>. 이 경계가 검증이 사는 유일한 지점이다★ */
  parseAnswer(_round, raw): ParseResult<DummyAnswer> {
    const r = AnswerSchema.safeParse(raw);
    if (!r.success) return { ok: false, reason: 'INVALID', message: '보기 중에서 고르세요' };
    return { ok: true, value: r.data };
  },

  /** LOCKED 진입 시 1회. 순수 + 결정적. ★배수를 보지 못한다 — 코어가 곱한다★ */
  score(_round, bag: SubmissionBag<DummyAnswer>): ScoreResult {
    const baseDeltas = new Map<TeamId, number>();
    const callouts: Callout[] = [];
    const cells: { label: string; value: string; tone: 'GOOD' | 'BAD' | 'NEUTRAL' }[] = [];

    for (const team of bag.teams) {
      const members = bag.roster.filter((p) => p.teamId === team.teamId);
      let correct = 0;

      for (const p of members) {
        const sub = bag.scope === 'PARTICIPANT' ? bag.final.get(p.participantId) : undefined;
        if (!sub) {
          callouts.push({ kind: 'NO_SUBMIT', participantId: p.participantId, teamId: team.teamId, label: `${p.name} (${team.name})` });
        } else if (sub.value === ANSWER) {
          correct++;
          callouts.push({ kind: 'CORRECT', participantId: p.participantId, teamId: team.teamId, label: `${p.name} (${team.name})` });
        } else {
          callouts.push({ kind: 'WRONG', participantId: p.participantId, teamId: team.teamId, label: `${p.name} (${team.name})`, note: `${sub.value} 찍음` });
        }
      }

      baseDeltas.set(team.teamId, correct * 100);
      cells.push({
        label: team.name,
        value: `${correct}/${members.length}`,
        tone: correct > 0 ? 'GOOD' : 'BAD',
      });
    }

    // ★한 프레임에 그릴 것. 조별 순차 플립 금지 — "동시 공개"는 문자 그대로다★
    const reveal: ContentChunks = [
      { t: 'headline', text: `정답: ${ANSWER}` },
      { t: 'grid', cells },
    ];

    return { baseDeltas, reveal, callouts };
  },
};
