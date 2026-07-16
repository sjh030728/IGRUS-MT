import {
  GameId,
  RoundId,
  type Callout,
  type ContentChunks,
  type LockRevealGame,
  type ParseResult,
  type RoundSpec,
  type ScoreResult,
  type TeamId,
} from '@mt/protocol';
import type { QuizQuestion } from '../core/db.service.js';

/**
 * ═══ 동아리 내부 퀴즈 ═══ 8:03, 16분 = 실행 8분 + 리액션 8분 (program-ops.md)
 *
 * 문항은 설문(docs/survey.md)에서 오고 Postgres 문제 은행에 산다 — 실명이라 git 금지.
 * "이 중 ○○한 사람은?" → 보기 4명 중 고르기. PARTICIPANT scope — 40명이 각자 낸다.
 *
 * ★폰엔 A~D 글자만 간다. 이름은 빔에만 있다★
 * 이름까지 폰에 주면 아무도 빔을 안 보고, 빔을 안 보면 야유가 안 나온다.
 * (어휘 자체가 본문을 못 싣게 되어 있다 — play.ts)
 *
 * 채점: 맞힌 사람 수 × basePoints를 조에 더한다. 단순한 이유 — 점수가 방 전체에게
 * 즉시 읽혀야 한다("우리 조 4명 맞음 = +400"). 조 인원 편차는 임원이 배정에서 푼다
 * (program-ops.md "조 배정에 학번을 섞는다"). 앱이 정규화로 풀면 산수가 불투명해진다.
 */

/** 팩토리인 이유: 문제 은행(DB)은 코어 소유라 게임이 직접 못 잡는다 — 적재 함수만 주입받는다. */
export function makeQuizGame(loadQuestions: () => Promise<QuizQuestion[]>): LockRevealGame<string> {
  /**
   * roundId → 정답 글자. loadRounds가 채우고 score가 읽는다.
   * RoundSpec엔 정답을 실을 자리가 일부러 없다 — displayPrompt(빔)·playPrompt(폰)로
   * 흘러가는 타입이라, 정답이 거기 있으면 언젠가 샌다. 모듈 안에 가둔다.
   */
  const answerOf = new Map<string, { letter: string; name: string }>();

  return {
    gameId: GameId.parse('quiz'),
    kind: 'LOCK_REVEAL',
    title: '동아리 내부 퀴즈',
    answerScope: 'PARTICIPANT',

    /** 세그먼트 진입 시 1회. ★진행 중 DB 접근 금지★는 이 구조가 지킨다 — 여기서 다 읽는다. */
    async loadRounds(ctx): Promise<readonly RoundSpec[]> {
      const qs = await loadQuestions();
      if (qs.length === 0) {
        throw new Error('문제 은행이 비었습니다 — npm run db:seed -w @mt/server (개발은 db:seed:example)');
      }
      answerOf.clear();

      return qs.map((q, i): RoundSpec => {
        const roundId = RoundId.parse(`quiz-${q.id}`);
        const letters = ['A', 'B', 'C', 'D', 'E', 'F'].slice(0, q.choices.length);
        answerOf.set(roundId, { letter: letters[q.answerIndex]!, name: q.choices[q.answerIndex]! });

        return {
          roundId,
          segmentId: ctx.segmentId,
          index: i + 1,
          total: qs.length,
          displayPrompt: {
            title: '동아리 내부 퀴즈',
            content: [
              { t: 'headline', text: q.text },
              {
                t: 'choices',
                items: q.choices.map((name, j) => ({ label: `${letters[j]}. ${name}`, tone: 'NEUTRAL' })),
              },
            ],
          },
          // ★글자만★ 이름은 빔에 있다.
          playPrompt: {
            kind: 'choices',
            items: letters.map((L) => ({ value: L, label: L, tone: 'NEUTRAL' })),
          },
          hostBrief: {
            answerText: `${letters[q.answerIndex]} — ${q.choices[q.answerIndex]}`,
            // 설문 Q4 "마이크 받으면 한마디"가 그대로 사회자 멘트 힌트가 된다.
            ...(q.patter ? { patter: q.patter } : {}),
          },
          basePoints: 100,
          collectMs: 10_000,
          countdownMs: 3_000,
        };
      });
    },

    /** ★unknown → ParseResult<T>★ 보기는 라운드마다 다르니 spec의 어휘로 검사한다. */
    parseAnswer(round, raw): ParseResult<string> {
      const values = round.playPrompt.items.map((it) => it.value);
      if (typeof raw !== 'string' || !values.includes(raw)) {
        return { ok: false, reason: 'INVALID', message: '보기 중에서 고르세요' };
      }
      return { ok: true, value: raw };
    },

    /** LOCKED 진입 시 1회. 순수 + 결정적. ★배수를 보지 못한다 — 코어가 곱한다★ */
    score(round, bag): ScoreResult {
      const answer = answerOf.get(round.roundId);
      if (!answer) throw new Error(`quiz: 적재 안 된 라운드를 채점하려 함 — ${round.roundId}`);

      const baseDeltas = new Map<TeamId, number>();
      const callouts: Callout[] = [];
      const cells: { label: string; value: string; tone: 'GOOD' | 'BAD' }[] = [];

      for (const team of bag.teams) {
        const members = bag.roster.filter((p) => p.teamId === team.teamId);
        let correct = 0;

        for (const p of members) {
          const sub = bag.scope === 'PARTICIPANT' ? bag.final.get(p.participantId) : undefined;
          if (!sub) {
            callouts.push({ kind: 'NO_SUBMIT', participantId: p.participantId, teamId: team.teamId, label: `${p.name} (${team.name})` });
          } else if (sub.value === answer.letter) {
            correct++;
            callouts.push({ kind: 'CORRECT', participantId: p.participantId, teamId: team.teamId, label: `${p.name} (${team.name})` });
          } else {
            callouts.push({ kind: 'WRONG', participantId: p.participantId, teamId: team.teamId, label: `${p.name} (${team.name})`, note: `${sub.value} 찍음` });
          }
        }

        baseDeltas.set(team.teamId, correct * round.basePoints);
        cells.push({ label: team.name, value: `${correct}/${members.length}`, tone: correct > 0 ? 'GOOD' : 'BAD' });
      }

      // ★동시 공개 한 프레임★ 정답 이름이 빔에 처음 뜨는 순간 — "어? 걔가?"가 여기서 나온다.
      const reveal: ContentChunks = [
        { t: 'headline', text: `정답: ${answer.letter} — ${answer.name}` },
        { t: 'grid', cells },
      ];

      return { baseDeltas, reveal, callouts };
    },
  };
}
