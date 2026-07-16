/**
 * 문제 은행 시드. `npm run db:seed -w @mt/server` (실전) / `npm run db:seed:example` (가짜 8문제)
 *
 * ★실전 시드 파일(db/quiz.questions.json)은 gitignore다★ (docs/survey.md)
 * 내용이 "김철수가 1학년 때 ~했다" 같은 실명 개인정보라서다. 커밋하면 동아리원 신상을
 * 인터넷에 뿌리는 것이다. 예시 파일을 복사해서 실명 데이터로 바꿔 쓴다:
 *   cp db/quiz.questions.example.json db/quiz.questions.json
 *
 * 멱등: id 기준 upsert라 몇 번을 돌려도 같은 상태가 된다. 문항 수정 → 재시드가 워크플로다.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { z } from 'zod';

const Question = z.object({
  id: z.string().min(1),
  position: z.number().int(),
  text: z.string().min(1),
  choices: z.array(z.string().min(1)).min(2).max(6),
  answerIndex: z.number().int().nonnegative(),
  patter: z.string().optional(),
  enabled: z.boolean().default(true),
});
const SeedFile = z
  .object({ questions: z.array(Question).min(1) })
  .superRefine((f, ctx) => {
    const ids = f.questions.map((q) => q.id);
    const dup = ids.find((v, i) => ids.indexOf(v) !== i);
    if (dup) ctx.addIssue({ code: 'custom', message: `문제 id가 겹칩니다: "${dup}"` });
    for (const q of f.questions) {
      if (q.answerIndex >= q.choices.length) {
        ctx.addIssue({ code: 'custom', message: `"${q.id}": answerIndex(${q.answerIndex})가 보기(${q.choices.length}개) 밖입니다` });
      }
    }
  });

const arg = process.argv[2];
const path = arg
  ? arg
  : fileURLToPath(new URL('./quiz.questions.json', import.meta.url));

if (!existsSync(path)) {
  console.error(`시드 파일이 없습니다: ${path}`);
  console.error('실전 데이터라면:  cp apps/server/db/quiz.questions.example.json apps/server/db/quiz.questions.json 후 실명 문항으로 수정');
  console.error('개발/리허설이면:  npm run db:seed:example -w @mt/server');
  process.exit(1);
}

const parsed = SeedFile.safeParse(JSON.parse(readFileSync(path, 'utf8')));
if (!parsed.success) {
  console.error(`시드 파일이 잘못됐습니다 (${path}):`);
  for (const i of parsed.error.issues) console.error(`  · ${i.path.join('.') || '(최상위)'} — ${i.message}`);
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://mt:mt@localhost:5432/mt' });
try {
  await pool.query(readFileSync(fileURLToPath(new URL('./schema.sql', import.meta.url)), 'utf8'));
  for (const q of parsed.data.questions) {
    await pool.query(
      `INSERT INTO quiz_question (id, position, text, choices, answer_index, patter, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         position = EXCLUDED.position, text = EXCLUDED.text, choices = EXCLUDED.choices,
         answer_index = EXCLUDED.answer_index, patter = EXCLUDED.patter, enabled = EXCLUDED.enabled`,
      [q.id, q.position, q.text, JSON.stringify(q.choices), q.answerIndex, q.patter ?? null, q.enabled],
    );
  }
  const n = parsed.data.questions.filter((q) => q.enabled).length;
  console.log(`시드 완료 — ${parsed.data.questions.length}문항 upsert (enabled ${n}개) ← ${path}`);
  if (path.includes('example')) {
    console.log('★가짜 데이터다★ 실전은 설문 응답으로 quiz.questions.json을 만들어 db:seed로 넣을 것 (docs/survey.md)');
  }
} catch (e) {
  console.error(`DB에 못 붙었습니다 — ${e.message}`);
  console.error('레포 루트에서: docker compose up -d');
  process.exit(1);
} finally {
  await pool.end();
}
