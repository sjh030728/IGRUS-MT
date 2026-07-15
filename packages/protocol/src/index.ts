/**
 * @mt/protocol — 서버·빔·폰·콘솔이 공유하는 계약.
 *
 * CLAUDE.md 일정 W1: "WS 이벤트 스키마 + 게임 인터페이스 2종 계약 정의. 코드 거의 안 씀"
 *
 * 이 패키지에 로직은 없다. 모양만 있다.
 * 분담이 게임이 아니라 레이어로 나뉘어 있어서(A=서버/콘솔, B=빔/폰/연출/사운드)
 * 두 사람이 만나는 지점이 정확히 이 파일들이다. 여기가 어긋나면 W7에 알게 된다.
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
