// One-off: apply E-356 (ai_call_outcomes + lead_callbacks — AI dialer outcome
// categories and tracked callbacks) to database-1 (sandbox) or database-2 (prod).
//
//   node scripts/_apply-e356.mjs database-1
//   node scripts/_apply-e356.mjs database-2
//
// DDL, additive. Reads that host's URL from .env.local (commented or not),
// never prints it. Applies the file twice (the second pass must be a no-op),
// then checks on a FRESH connection — postgres.js DDL is not undone by a
// rollback, so the check is a real one.
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

const file = readFileSync("drizzle/E-356_ai_call_outcomes_callbacks.sql", "utf8");
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
  for (const rel of [
    "ai_call_outcomes",
    "lead_callbacks",
    "lead_callbacks_one_open_per_lead",
    "lead_callbacks_due_idx",
    "ai_call_outcomes_campaign_idx",
    "ai_call_outcomes_needs_review_idx",
  ]) {
    const [r] = await check`SELECT to_regclass(${"public." + rel}) IS NOT NULL AS ok`;
    if (!r.ok) throw new Error(`✗ ${rel} missing`);
  }
  // The partial unique index must carry its predicate, not just exist.
  const [p] = await check`
    SELECT pg_get_indexdef('public.lead_callbacks_one_open_per_lead'::regclass) AS def`;
  if (!/WHERE/i.test(p.def)) throw new Error(`✗ one-open-per-lead index has no predicate: ${p.def}`);
  const [c] = await check`
    SELECT count(*)::int AS n FROM pg_constraint
     WHERE conname IN ('lead_callbacks_owner_type_check', 'lead_callbacks_status_check')`;
  if (c.n !== 2) throw new Error(`✗ expected 2 CHECK constraints, found ${c.n}`);
  console.log("✓ E-356 applied");
} finally {
  await check.end();
}
