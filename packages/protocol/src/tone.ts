import { z } from 'zod';

/**
 * 형광 팔레트. CLAUDE.md 타협 금지: "배경 #000 + 형광 텍스트. 회색 계열 UI 금지."
 *
 * ★display.ts가 아니라 독립 파일인 이유★ (단계 3에서 분리)
 * DisplayState의 LIVE 모드가 live.ts의 타입을 필요로 하고, live.ts는 Tone을 쓴다.
 * Tone이 display.ts에 살면 두 파일이 서로를 import하는 순환이 되는데, Zod 스키마는
 * 모듈 적재 시점에 평가되므로 순환의 한쪽이 undefined인 채 z.object가 만들어진다 —
 * 컴파일은 통과하고 ★부팅에서 터진다★. 공유 어휘를 밑으로 내려서 순환을 끊는다.
 */
export const Tone = z.enum([
  'NEUTRAL', // 형광 시안
  'GOOD', // 형광 그린 — 정답 / 점수 상승
  'BAD', // 형광 핑크 — 오답 / 점수 하락 / 배신
  'HOT', // 형광 옐로 — 강조 / ×2 배지
]);
export type Tone = z.infer<typeof Tone>;
