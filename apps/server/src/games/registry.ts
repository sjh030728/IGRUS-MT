import type { Game, GameId } from '@mt/protocol';
import type { QuizQuestion } from '../core/db.service.js';
import { betrayalGame } from './betrayal.game.js';
import { makeQuizGame } from './quiz.game.js';
import { tapTugGame } from './tap-tug.game.js';

/**
 * 게임 등록부. 코어(세그먼트 러너)는 gameId → 모듈만 알고 안은 안 본다.
 *
 * ★부팅 때 program의 모든 gameId가 여기 있는지 검사한다★ (round.service 생성자)
 * config가 없는 게임을 가리키면 7:30에 터진다 — 8:03에 SEGMENT_GOTO가 조용히
 * 실패하는 것보다 낫다.
 */
export function buildGames(deps: { loadQuizQuestions: () => Promise<QuizQuestion[]> }): ReadonlyMap<GameId, Game> {
  const list: Game[] = [makeQuizGame(deps.loadQuizQuestions), betrayalGame, tapTugGame];
  return new Map(list.map((g) => [g.gameId, g]));
}
