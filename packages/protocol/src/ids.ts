import { z } from 'zod';

/**
 * ID는 전부 런타임엔 그냥 문자열이다. 다만 타입만 서로 다르게 "도장(brand)"을 찍어둔다.
 *
 * 왜:
 *   deltas[teamId]        // 맞음
 *   deltas[participantId] // 도장이 없으면 이것도 컴파일 통과 → 8시 35분에 점수가 조용히 틀림
 * 도장을 찍으면 두 번째 줄이 컴파일 에러가 된다. 실행 중엔 여전히 문자열이라 비용 0.
 *
 * 값을 만들 땐 TeamId.parse('t1')로 통과시킨다. 만드는 지점은
 * 로스터 적재 / 라운드 적재 / WS 수신 세 곳뿐이고, 그 뒤론 그냥 흘러다닌다.
 */
export const SessionId = z.string().min(1).brand<'SessionId'>();
export type SessionId = z.infer<typeof SessionId>;

/** 프로그램의 한 꼭지. "내부 퀴즈", "탭 줄다리기" 같은 단위. */
export const SegmentId = z.string().min(1).brand<'SegmentId'>();
export type SegmentId = z.infer<typeof SegmentId>;

/** 세그먼트 안의 한 판. 퀴즈 8문제 = 라운드 8개. */
export const RoundId = z.string().min(1).brand<'RoundId'>();
export type RoundId = z.infer<typeof RoundId>;

/** Live 전용. 탭 줄다리기 토너먼트의 한 경기. */
export const MatchId = z.string().min(1).brand<'MatchId'>();
export type MatchId = z.infer<typeof MatchId>;

export const TeamId = z.string().min(1).brand<'TeamId'>();
export type TeamId = z.infer<typeof TeamId>;

export const ParticipantId = z.string().min(1).brand<'ParticipantId'>();
export type ParticipantId = z.infer<typeof ParticipantId>;

/** 게임 모듈의 이름. 'quiz' | 'betrayal' | 'tap-tug' 같은 것. */
export const GameId = z.string().min(1).brand<'GameId'>();
export type GameId = z.infer<typeof GameId>;

/**
 * 폰이 자기 신원을 되찾는 열쇠. localStorage에 저장했다가 재접속 때 다시 낸다.
 * CLAUDE.md 위험목록: "물놀이 후 8시면 20% 이하 속출. 이탈/재접속 처리가 실제로 필요하다."
 */
export const ResumeToken = z.string().min(16).brand<'ResumeToken'>();
export type ResumeToken = z.infer<typeof ResumeToken>;

/**
 * 와이어를 건너는 모든 시각은 "서버 기준 절대 시각(epoch ms)"이다.
 *
 * 남은 시간(duration)은 절대 보내지 않는다. "10초 남음"을 보내면 패킷이 20ms 걸린 순간
 * 클라이언트마다 기준이 어긋나고, 40대가 서로 다른 프레임에 0에 닿는다.
 * "1784000000000에 끝남"을 보내면 전원이 같은 프레임에 착지한다.
 *
 * 이 한 줄이 카운트다운 정확도 + BGM 오프셋 재개 + 재접속 시 스팅 재생 방지를 동시에 떠받친다.
 */
export const EpochMs = z.number().int().nonnegative();
export type EpochMs = z.infer<typeof EpochMs>;

/** 원장(ledger) 기입의 일련번호. DB가 매긴다. 되감기가 이 번호를 지목한다. */
export const Seq = z.number().int().positive();
export type Seq = z.infer<typeof Seq>;
