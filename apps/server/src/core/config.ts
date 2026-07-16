import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { GameId, SegmentId, TeamId, TeamInfo } from '@mt/protocol';
import type { SegmentDef } from './state.js';

/**
 * ═══ 세션 설정 ═══
 *
 * CLAUDE.md: "당일 1회성 운영이 목표지만, ★이후 행사 재사용을 전제로 설계한다★."
 * 조 개수·이름·색이 코드에 박혀 있으면 그 문장이 거짓말이 된다. 다음 행사는 조가 5개다.
 *
 * ★JSON인 이유 — 7시 30분에 고칠 수 있어야 한다★
 * .ts로 두면 조를 하나 늘리는 데 `npm run build`가 필요하고, 빌드가 깨지면 그걸 아는 시점이
 * 7시 55분이다. JSON은 고치고 재시작만 하면 된다. 이건 코드가 아니라 그날의 데이터다.
 *
 * ★그런데 Zod로 검사하는 이유 — 사람 손을 건넌다★
 * game.ts: "Zod는 런타임에도 검사가 필요한 것에 쓴다. 즉 와이어를 건너오는 것 —
 * 폰은 남의 컴퓨터라 뭐가 올지 모르니 실행 중에 확인해야 한다."
 * 이 파일은 와이어를 안 건넌다. 대신 ★7시 30분의 사람★을 건넌다. 쉼표 하나 빠진 JSON을
 * TypeScript는 절대 못 잡는다. 경계의 성질이 같으므로 같은 도구를 쓴다.
 */

const TeamSpec = z.object({
  /** 와이어에 실리는 식별자. 짧게. 바꾸면 진행 중인 세션의 점수가 안 붙는다. */
  id: z.string().min(1),
  /** 빔과 폰에 뜨는 이름. "1조", "레드팀", 뭐든. */
  name: z.string().min(1),
  color: TeamInfo.shape.color,
});

/**
 * 프로그램의 한 꼭지. ★세그먼트는 게임이 없어도 된다★ (decisions/0002) —
 * SCOREBOARD(낮 점수 공개)와 AWARD(시상)가 그것이고, 이 둘이 빔 모드
 * SCOREBOARD_FULL/AWARD의 유일한 공급원이다. 콘솔이 모드를 직접 정하는 명령은 없다.
 *
 * game 문자열이 진짜 게임인지는 여기서 모른다 — 등록부 대조는 서버 부팅이 한다.
 * (config는 계약과 게임 목록을 모르는 채로 검증 가능해야 7:30에 사람이 고칠 수 있다.)
 */
const SegmentSpec = z.discriminatedUnion('kind', [
  z.object({ id: z.string().min(1), kind: z.literal('SCOREBOARD'), title: z.string().min(1) }),
  z.object({ id: z.string().min(1), kind: z.literal('AWARD'), title: z.string().min(1) }),
  z.object({ id: z.string().min(1), kind: z.literal('GAME'), title: z.string().min(1), game: z.string().min(1) }),
]);

export const SessionConfig = z
  .object({
    /** 편집자용 메모. 스키마에 넣어둬야 strict가 안 튕긴다 (JSON엔 주석을 못 쓴다). */
    _help: z.string().optional(),
    sessionId: z.string().min(1),
    /** 빔 표지 + 세그먼트 제목. */
    title: z.string().min(1),
    /**
     * ★상한 6은 임의가 아니다★ 형광 팔레트가 6색이고(session.ts), 그건
     * CLAUDE.md "배경 #000 + 형광 텍스트, 회색 계열 금지 — 뒷줄에서 읽혀야 한다"에서 나온다.
     * 7조를 만들려면 뒷줄에서 구분되는 형광색을 하나 더 찾아야 한다. 코드 문제가 아니다.
     */
    teams: z
      .array(TeamSpec)
      .min(2, { message: '조가 최소 2개는 있어야 대결이 됩니다.' })
      .max(6, {
        message:
          '조는 최대 6개입니다. 형광 팔레트가 6색이라서고, 그건 "뒷줄에서 읽혀야 한다"에서 나온 제약입니다. ' +
          '7조를 만들려면 밝은 방 + 저가 빔에서 나머지 6색과 구분되는 형광색을 하나 더 찾아야 합니다 — 코드 문제가 아닙니다.',
      }),
    /** 그날의 라인업. 순서가 곧 진행 순서고, 첫 항목이 부팅 화면이다. */
    program: z.array(SegmentSpec).min(1, { message: '프로그램이 비어 있으면 띄울 게 없습니다.' }),
  })
  .strict() // 오타 난 키를 조용히 무시하면 7:30에 안 먹은 이유를 못 찾는다
  .superRefine((c, ctx) => {
    const dup = <T>(xs: T[]) => xs.find((v, i) => xs.indexOf(v) !== i);

    const id = dup(c.teams.map((t) => t.id));
    if (id !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['teams'], message: `조 id가 겹칩니다: "${id}". 점수가 한 조에 합쳐집니다.` });
    }

    const seg = dup(c.program.map((s) => s.id));
    if (seg !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['program'], message: `세그먼트 id가 겹칩니다: "${seg}". SEGMENT_GOTO가 어딜 갈지 모르게 됩니다.` });
    }

    // ★이게 제일 중요한 검사다★ 두 조가 같은 색이면 빔 점수판에서 구분이 안 된다.
    // 타입으론 못 막는다 — 둘 다 합법적인 색이라서. 그래서 여기서 막는다.
    const color = dup(c.teams.map((t) => t.color));
    if (color !== undefined) {
      const who = c.teams.filter((t) => t.color === color).map((t) => t.name).join(', ');
      ctx.addIssue({
        code: 'custom',
        path: ['teams'],
        message: `색이 겹칩니다: ${who} 가 전부 ${color} 입니다. 빔에서 같은 색이면 점수판을 구분할 수 없습니다.`,
      });
    }
  });
export type SessionConfig = z.infer<typeof SessionConfig>;

/**
 * ★부팅 때 크게 터진다★
 * 8시 정각에 조가 3개만 뜨는 것보다 7시 30분에 아예 안 켜지는 게 낫다.
 * 조용히 기본값으로 넘어가는 건 최악이다 — 틀린 채로 돌아가고 아무도 모른다.
 */
export function loadSessionConfig(): SessionConfig {
  const path =
    process.env['SESSION_CONFIG'] ??
    fileURLToPath(new URL('../../session.config.json', import.meta.url));

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`[config] ${path} 를 읽지 못했습니다 — ${(e as Error).message}`);
  }

  const r = SessionConfig.safeParse(raw);
  if (!r.success) {
    const lines = r.error.issues.map((i) => `  · ${i.path.join('.') || '(최상위)'} — ${i.message}`);
    throw new Error(`[config] ${path} 가 잘못됐습니다:\n${lines.join('\n')}`);
  }
  return r.data;
}

/**
 * 설정 → 계약 타입.
 * ★memberIds는 여기서 안 채운다★ 조원은 설정이 아니라 ★누가 실제로 들어왔나★로 정해진다.
 * program-ops.md는 "배정은 임원이 사전에 하고 앱은 받기만 한다"이고, 앱이 받는 건 접속이다.
 * 투영기가 로스터에서 매 스냅샷 채운다 — 파생 상태지 저장할 값이 아니다.
 */
export function toTeams(c: SessionConfig): TeamInfo[] {
  return c.teams.map((t) => ({
    teamId: TeamId.parse(t.id),
    name: t.name,
    color: t.color,
    memberIds: [],
  }));
}

/** 설정 → 서버 세그먼트 정의. 게임 존재 검사는 호출자(round.service 생성자) 몫. */
export function toProgram(c: SessionConfig): SegmentDef[] {
  return c.program.map((s) => ({
    segmentId: SegmentId.parse(s.id),
    kind: s.kind,
    title: s.title,
    gameId: s.kind === 'GAME' ? GameId.parse(s.game) : null,
  }));
}
