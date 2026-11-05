// One-off: apply E-372 (scheduled_job_state — when each in-process job last ran,
// ID 227) to database-1 (sandbox) or database-2 (prod).
//
//   node scripts/_apply-e372.mjs database-1
//   node scripts/_apply-e372.mjs database-2
//   ENV_FILE=../.env.local node scripts/_apply-e372.mjs database-1   (from a worktree)
//
// Additive: one new table + a status CHECK, not mirrored in schema.ts. Reads that
// host's URL from .env.local (commented or not), never prints it. Applies the file
// twice (the second pass must be a no-op), then re-checks the table on a FRESH
// connection.
import postgres from "postgres";
import { readFileSync } from "node:fs";

const target = process.argv[2];
if (!["database-1", "database-2"].includes(target)) throw new Error("usage: database-1 | database-2");
const line = readFileSync(process.env.ENV_FILE ?? ".env.local", "utf8")
  .split(/\r?\n/)
  .find((l) => /^\s*#?\s*DATABASE_URL=/.test(l) && l.includes(`${target}.`));
if (!line) throw new Error(`no DATABASE_URL for ${target} in .env.local`);
const url = line.replace(/^\s*#?\s*DATABASE_URL=/, "").trim().replace(/^["']|["']$/g, "");
const host = new URL(url).host;
if (!host.startsWith(`${target}.`)) throw new Error(`host mismatch: ${host}`);
console.log("target:", host.split(".")[0]);

const file = readFileSync("drizzle/E-372_scheduled_job_state.sql", "utf8");
const opts = { max: 1, prepare: false, ssl: { rejectUnauthorized: false } };

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
  const cols = await check`
    SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'scheduled_job_state'
     ORDER BY ordinal_position`;
  console.table(cols);
  if (cols.length !== 8) throw new Error(`expected 8 scheduled_job_state columns, found ${cols.length}`);
  const cons = await check`
    SELECT conname FROM pg_constraint
     WHERE conname IN ('scheduled_job_state_pkey', 'scheduled_job_state_status_check')`;
  if (cons.length !== 2) throw new Error(`expected PK + status CHECK, found ${cons.map((c) => c.conname).join(", ")}`);
  console.log("E-372 verified: scheduled_job_state + PK + status CHECK");
} finally {
  await check.end();
}
