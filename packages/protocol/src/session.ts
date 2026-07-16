import { z } from 'zod';
import { EpochMs, GameId, ParticipantId, SegmentId, TeamId } from './ids.js';

/**
 * 조. 낮 야외 PG부터 이어지는 단위이고, 점수는 전부 여기에 붙는다.
 * CLAUDE.md 운영 노트: "조 배정에 학번을 섞는다" — 배정은 임원이 사전에 하고 앱은 받기만 한다.
 */
export const TeamInfo = z.object({
  teamId: TeamId,
  name: z.string().min(1),
  /** 빔에서 이 조를 나타낼 형광색. 회색 계열 금지는 CLAUDE.md 타협 금지 항목. */
  color: z.enum(['GREEN', 'PINK', 'YELLOW', 'CYAN', 'ORANGE', 'PURPLE']),
  memberIds: z.array(ParticipantId).readonly(),
});
export type TeamInfo = z.infer<typeof TeamInfo>;

export const RosterEntry = z.object({
  participantId: ParticipantId,
  teamId: TeamId,
  name: z.string().min(1),
  connected: z.boolean(),
  /** 마지막으로 살아있던 시각. 콘솔이 "3조 2명 끊김"을 보여주는 근거. */
  lastSeen: EpochMs,
  /**
   * ★조용히★ 무음 처리 (MUTE_PARTICIPANT). 제출·탭이 성공한 척하고 버려진다 —
   * 에러를 주면 치터가 다른 폰으로 갈아탄다. 이 필드는 HostSnapshot으로만 나간다
   * (폰 스냅샷엔 roster가 없다) — 본인은 끝까지 모른다.
   */
  muted: z.boolean(),
});
export type RosterEntry = z.infer<typeof RosterEntry>;

/**
 * 점수판. 빔에 상시 노출된다 — CLAUDE.md: "순위 변동이 보여야 야유가 나온다."
 * rank는 서버가 계산해서 내려준다. 클라 3개가 각자 정렬하면 동점 처리가 어긋난다.
 */
export const ScoreRow = z.object({
  teamId: TeamId,
  name: z.string(),
  color: TeamInfo.shape.color,
  total: z.number().int(),
  rank: z.number().int().positive(),
  /** 직전 확정 대비 변화량. 점수 애니메이션이 이 값으로 굴러간다. 없으면 null. */
  lastDelta: z.number().int().nullable(),
});
export type ScoreRow = z.infer<typeof ScoreRow>;

export const Scoreboard = z.object({
  rows: z.array(ScoreRow).readonly(),
  /** 마지막으로 반영된 원장 기입 번호. 클라가 "이미 본 점수인가"를 판단한다. */
  throughSeq: z.number().int().nonnegative(),
});
export type Scoreboard = z.infer<typeof Scoreboard>;

/**
 * 세그먼트 종류 — 프로그램의 한 꼭지가 뭘 하는가.
 *
 * ★세그먼트는 게임이 없어도 된다★ (decisions/0002)
 * 낮 점수 공개(SCOREBOARD)와 시상(AWARD)이 그것이다. "세그먼트 = 게임"으로 짜면
 * 그 둘이 살 곳이 없어져 손이 DISPLAY_MODE로 돌아간다 — 빔 모드의 진실이 두 줄기가 된다.
 * 빔 모드는 이 kind에서 파생된다: SCOREBOARD → SCOREBOARD_FULL / AWARD → AWARD / GAME → ROUND.
 */
export const SegmentKind = z.enum(['SCOREBOARD', 'GAME', 'AWARD']);
export type SegmentKind = z.infer<typeof SegmentKind>;

/**
 * 콘솔에 뜨는 프로그램 한 줄. 사회자가 SEGMENT_GOTO로 지목할 대상이다.
 * 서버 쪽 세그먼트 정의는 session.config.json에 산다 — 그날의 데이터라서.
 */
export const ProgramRow = z.object({
  segmentId: SegmentId,
  title: z.string(),
  kind: SegmentKind,
  /** kind가 GAME일 때만 non-null. */
  gameId: GameId.nullable(),
  current: z.boolean(),
});
export type ProgramRow = z.infer<typeof ProgramRow>;

/** 폰이 아는 자기 자신. */
export const Me = z.object({
  participantId: ParticipantId,
  teamId: TeamId,
  name: z.string(),
  teamName: z.string(),
  teamColor: TeamInfo.shape.color,
});
export type Me = z.infer<typeof Me>;
