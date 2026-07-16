import type { SubmissionRecord } from '@mt/protocol';

/**
 * ★"최종 답" 접기가 이 한 곳에 산다★
 *
 * 잠금 채점(round.service)과 폰 스냅샷의 "우리 조 답"(projector)이 같은 질문을 한다 —
 * "이 키의 지금 답이 뭐냐." 두 곳이 각자 접으면 타이브레이크가 어긋나고, 어긋난 걸
 * 아는 시점은 잠긴 답과 폰에 떠 있던 답이 다른 8시 35분이다.
 *
 * 규칙은 한 줄이다: ★로그에서 나중에 온 것이 이긴다★
 * log는 도착 순서로 쌓이고(submit이 push), revision도 at도 그 순서를 따라 증가한다.
 * 그래서 "마지막 제출"이 revision 최대이자 at 최신이자 로그의 마지막이다 — 셋 중 뭘
 * 비교하든 같지만, 비교 자체가 필요 없다. 순서대로 덮어쓰면 끝이다.
 */
export function foldFinal<K>(
  log: readonly SubmissionRecord<unknown>[],
  keyOf: (x: SubmissionRecord<unknown>) => K,
): Map<K, SubmissionRecord<unknown>> {
  const final = new Map<K, SubmissionRecord<unknown>>();
  for (const x of log) final.set(keyOf(x), x);
  return final;
}
