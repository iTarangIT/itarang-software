// One-off: apply E-386 (dealer visit outcomes + next visit, ID 241-2) to database-1
// (sandbox) or database-2 (prod).
//
//   node scripts/_apply-e386.mjs database-1
//
// Three additive columns on lead_visits + one partial index. Reads that host's URL from the
// env file, never prints it. Applies twice (the second pass must be a no-op), then re-checks
// the columns and the index on a FRESH connection.
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
const file = readFileSync("drizzle/E-386_dealer_visit_outcomes.sql", "utf8");
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
    SELECT column_name, data_type FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'lead_visits'
       AND column_name IN ('dealer_outcome', 'reported_amount', 'no_follow_up') ORDER BY 1`;
  const idx = await check`SELECT indexname FROM pg_indexes WHERE indexname = 'lead_visits_account_idx'`;
  console.log("columns:", cols.map((c) => `${c.column_name} ${c.data_type}`).join(", "));
  console.log("index:", idx.length ? "lead_visits_account_idx" : "MISSING");
  if (cols.length !== 3 || idx.length !== 1) process.exitCode = 1;
} finally {
  await check.end();
}
