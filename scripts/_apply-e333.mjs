// One-off: apply E-333 (Undo Mark Won + Change Lost reason, tracker IDs
// 80 / 134 / 136) to database-1 (sandbox) or database-2 (prod).
//
//   node scripts/_apply-e333.mjs database-1
//   node scripts/_apply-e333.mjs database-2
//
// Additive DDL. Reads that host's URL from .env.local (commented or not), never
// prints it. Applies the file twice (the second pass must be a no-op), then
// re-checks the table and the three columns on a FRESH connection.
import postgres from "postgres";
import { readFileSync } from "node:fs";

const target = process.argv[2];
if (!["database-1", "database-2"].includes(target)) throw new Error("usage: database-1 | database-2");
const line = readFileSync(".env.local", "utf8")
  .split(/\r?\n/)
  .find((l) => /^\s*#?\s*DATABASE_URL=/.test(l) && l.includes(`${target}.`));
if (!line) throw new Error(`no DATABASE_URL for ${target} in .env.local`);
const url = line.replace(/^\s*#?\s*DATABASE_URL=/, "").trim().replace(/^["']|["']$/g, "");
const host = new URL(url).host;
if (!host.startsWith(`${target}.`)) throw new Error(`host mismatch: ${host}`);
console.log("target:", host.split(".")[0]);

const file = readFileSync("drizzle/E-333_won_undo_and_lost_reason_change.sql", "utf8");
const opts = { max: 1, prepare: false, ssl: { rejectUnauthorized: false } };

const run = postgres(url, opts);
try {
  await run.unsafe(file);
  await run.unsafe(file);
  console.log("applied twice");
} finally {
  await run.end();
}

const check = postgres(url, opts);
try {
  const [t] = await check`SELECT to_regclass('lead_won_undo_requests')::text AS t`;
  const cols = await check`
    SELECT table_name || '.' || column_name AS c FROM information_schema.columns
     WHERE (table_name = 'dealer_lead_status_history' AND column_name = 'won_undone_at')
        OR (table_name = 'dealer_onboarding_applications' AND column_name IN ('withdrawn_at', 'withdrawn_reason'))
     ORDER BY 1`;
  console.log("table:", t.t);
  console.log("columns:", cols.map((r) => r.c));
  if (!t.t || cols.length !== 3) {
    console.error("E-333 NOT complete");
    process.exitCode = 1;
  } else {
    console.log("E-333 OK");
  }
} finally {
  await check.end();
}
