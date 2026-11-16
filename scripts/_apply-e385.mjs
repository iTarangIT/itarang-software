// One-off: apply E-385 (AI Analyst morning questions table, 251 item 23) to database-1
// (sandbox) or database-2 (prod).
//
//   node scripts/_apply-e385.mjs database-1
//   ENV_FILE=../itarang-software/.env.local node scripts/_apply-e385.mjs database-1   (from a worktree)
//
// Additive table + indexes. Reads that host's URL from the env file, never prints it. Applies
// twice (the second pass must be a no-op), then re-checks the table and its indexes on a FRESH
// connection.
import postgres from "postgres";
import { readFileSync } from "node:fs";

const target = process.argv[2];
if (!["database-1", "database-2"].includes(target)) throw new Error("usage: database-1 | database-2");
const line = readFileSync(process.env.ENV_FILE ?? ".env.local", "utf8")
  .split(/\r?\n/)
  .find((l) => /^\s*#?\s*DATABASE_URL=/.test(l) && l.includes(`${target}.`));
if (!line) throw new Error(`no DATABASE_URL for ${target} in the env file`);
const url = line.replace(/^\s*#?\s*DATABASE_URL=/, "").trim().replace(/^["']|["']$/g, "");
const host = new URL(url).host;
if (!host.startsWith(`${target}.`)) throw new Error(`host mismatch: ${host}`);
console.log("target:", host.split(".")[0]);

const opts = { max: 1, prepare: false, ssl: { rejectUnauthorized: false } };
const file = readFileSync("drizzle/E-385_analyst_daily_questions.sql", "utf8");
const sql = postgres(url, { ...opts, onnotice: (n) => console.log("notice:", n.message) });
try {
  for (const pass of [1, 2]) {
    await sql.begin((tx) => tx.unsafe(file));
    console.log(`pass ${pass}: ok`);
  }
} finally {
  await sql.end();
}

const check = postgres(url, opts);
try {
  const [t] = await check`SELECT to_regclass('public.analyst_daily_questions') IS NOT NULL AS ok`;
  const idx = await check`
    SELECT indexname FROM pg_indexes WHERE tablename = 'analyst_daily_questions' ORDER BY 1`;
  console.log("table:", t.ok ? "present" : "MISSING");
  console.log("indexes:", idx.map((r) => r.indexname).join(", "));
  if (!t.ok) process.exitCode = 1;
} finally {
  await check.end();
}
