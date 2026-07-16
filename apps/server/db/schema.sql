-- 테이블 2개가 전부다. CLAUDE.md: "PostgreSQL은 문제 은행 + 결과 아카이브 전용."
-- 서버 부팅과 시드 스크립트가 둘 다 이 파일을 실행한다 (IF NOT EXISTS라 멱등).

-- 문제 은행. ★이 테이블의 내용은 실명 개인정보다 — git에 절대 올리지 않는다★ (docs/survey.md)
CREATE TABLE IF NOT EXISTS quiz_question (
  id           TEXT PRIMARY KEY,
  -- 출제 순서. ORDER BY position, id — 결정적이어야 재시작 복구가 roundId로 맞물린다.
  position     INT NOT NULL,
  text         TEXT NOT NULL,
  -- 보기 이름 배열 (JSONB). ["김철수","이영희","박민수","정수현"]
  choices      JSONB NOT NULL,
  -- 0부터. choices 범위 검사는 시드 스크립트와 서버 적재가 한다.
  answer_index INT NOT NULL,
  -- 정답 공개 후 사회자 멘트 (설문 Q4 "마이크 받으면 한마디").
  patter       TEXT,
  -- 그날 뺄 문제는 지우지 말고 끈다. 임원 필터가 여기로 반영된다.
  enabled      BOOLEAN NOT NULL DEFAULT TRUE
);

-- 점수 원장 아카이브. 메모리 원장의 미러 + 재시작 복구의 원천 (ledger.ts).
-- entry는 계약(LedgerEntry) JSON 그대로 — 서버가 다시 읽을 때 Zod로 검증한다.
CREATE TABLE IF NOT EXISTS session_ledger (
  session_id TEXT NOT NULL,
  seq        INT  NOT NULL,
  entry      JSONB NOT NULL,
  PRIMARY KEY (session_id, seq)
);
