import { z } from 'zod';
import { Tone } from './tone.js';

/**
 * ═══ 폰 입력 어휘 ═══ DisplayChunk의 폰 판이다.
 *
 * 게임이 폰 입력 UI를 자유롭게 그리는 게 아니라 이 중에서 고른다. 이유도 display.ts와
 * 같다 — 엄지 크기·마감 10초 안의 판단 속도는 게임마다 다시 판단할 문제가 아니다.
 *
 * ★여기에 "문제 본문" 필드가 없다는 게 이 파일의 절반이다★
 * events.ts: "폰에 문제 본문은 안 간다 — 빔을 보게 하려고." 주석이 아니라 어휘 자체에
 * 본문을 실을 자리가 없다. 퀴즈가 폰에 이름 4개를 주고 싶어도 label에 'A'를 넣는 것
 * 말고는 방법이 없어야 한다 — 이름은 빔에 있고, 폰에 주는 순간 아무도 빔을 안 본다.
 */
export const ChoiceItem = z.object({
  /** 서버로 돌아가는 값. 게임의 parseAnswer가 이걸 검사한다. 라벨과 분리 — 라벨은 바뀌어도 값은 계약이다. */
  value: z.string().min(1),
  /** 버튼에 그릴 것. 퀴즈 'A'~'D' / 배신 '협력'·'배신'. */
  label: z.string().min(1),
  tone: Tone,
});
export type ChoiceItem = z.infer<typeof ChoiceItem>;

/**
 * 객관식 버튼판. 단계 2의 두 게임(퀴즈·배신)이 전부 이걸로 그려진다.
 * ★최대 6인 이유★: 폰 세로 화면에서 엄지로 안 헷갈리게 누를 수 있는 버튼 상한.
 * 그리고 6개면 이미 너무 많다 — 마감 10초 안에 읽고 골라야 한다.
 */
export const ChoicePrompt = z.object({
  kind: z.literal('choices'),
  items: z.array(ChoiceItem).min(2).max(6).readonly(),
});
export type ChoicePrompt = z.infer<typeof ChoicePrompt>;

/**
 * 판별 유니온인 이유: 새 입력 모양(예: 자유 텍스트)이 필요한 게임이 오면 멤버를 추가하고,
 * 폰의 switch가 빠짐없음 검사로 그 화면을 강제로 만들게 된다.
 * (개수를 세지 않는다 — 목록이 움직인다. 지금은 필요한 게 이것뿐일 뿐이다.)
 */
export const PlayPrompt = z.discriminatedUnion('kind', [ChoicePrompt]);
export type PlayPrompt = z.infer<typeof PlayPrompt>;
