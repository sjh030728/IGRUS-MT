/**
 * @mt/protocol — 서버·빔·폰·콘솔이 공유하는 계약.
 *
 * CLAUDE.md 일정 단계 0: "WS 이벤트 스키마 + 게임 인터페이스 2종 계약 정의"
 *
 * 이 패키지에 로직은 없다. 모양만 있다.
 * ★게임이 아니라 레이어로 짜기 때문에 모든 층이 여기서 만난다.★ 여기가 어긋나면
 * 단계 5(리허설)에 알게 된다.
 *
 * (원래 이 문단이 "A=서버/콘솔, B=빔/폰/연출/사운드 — ★두 사람이★ 만나는 지점"이었다.
 *  2명 시절 분담이고, CLAUDE.md는 "1인이 되면서 분담은 없어졌지만 ★순서 규칙으로 남는다★"다.)
 */

export * from './ids.js';
export * from './session.js';
export * from './phase.js';
export * from './display.js';
export * from './ledger.js';
export * from './live.js';
export * from './anticheat.js';
export * from './game.js';
export * from './events.js';
