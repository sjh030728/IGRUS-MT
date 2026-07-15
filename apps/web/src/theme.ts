import type { Tone, TeamInfo } from '@mt/protocol';

/**
 * ★형광 팔레트. CLAUDE.md 타협 금지★
 * "배경 #000 + 형광 텍스트. 회색 계열 UI 금지 — 밝은 방 + 저가 빔에서 전부 날아간다."
 *
 * 회색을 쓰고 싶어지는 순간이 반드시 온다(비활성 상태, 보조 텍스트...).
 * 빔에선 쓰지 마라. 대신 형광색의 투명도를 낮춘다 — 색상은 유지되고 밝기만 떨어진다.
 */
export const TONE: Record<Tone, string> = {
  NEUTRAL: '#00f0ff', // 형광 시안
  GOOD: '#39ff14', // 형광 그린
  BAD: '#ff2d95', // 형광 핑크
  HOT: '#faff00', // 형광 옐로
};

export const TEAM_COLOR: Record<TeamInfo['color'], string> = {
  GREEN: '#39ff14',
  PINK: '#ff2d95',
  YELLOW: '#faff00',
  CYAN: '#00f0ff',
  ORANGE: '#ff9500',
  PURPLE: '#bf5aff',
};

/** 형광은 글로우가 있어야 빔에서 산다. 저가 빔의 낮은 명암비를 이걸로 이긴다. */
export const glow = (color: string, strength = 1): string =>
  `0 0 ${8 * strength}px ${color}, 0 0 ${24 * strength}px ${color}55`;
