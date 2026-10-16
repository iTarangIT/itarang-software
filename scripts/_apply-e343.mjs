// One-off: apply E-343 (fixed "Limit passed" records, Hot / retry / quote
// clocks, holiday change log — IDs 85, 86, 15 Oct rework) to database-1
// (sandbox) or database-2 (prod).
//
//   node scripts/_apply-e343.mjs database-1
//   node scripts/_apply-e343.mjs database-2
//
// DDL, additive. Reads that host's URL from .env.local (commented or not),
// never prints it. Applies the file twice (the second pass must be a no-op),
// then checks on a FRESH connection — postgres.js DDL is not undone by a
// rollback, so the check is a real one. Run scripts/refresh-lead-clocks.ts
// afterwards so the new clocks are built.
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

const file = readFileSync("drizzle/E-343_limit_events_hot_clocks_holiday_log.sql", "utf8");
const opts = { max: 1, prepare: false, ssl: { rejectUnauthorized: false } };

const sql = postgres(url, { ...opts, onnotice: (n) => console.log("notice:", n.message) });
try {
  const [pre] = await sql`SELECT to_regclass('public.lead_clocks') IS NOT NULL AS ok`;
  if (!pre.ok) console.log("warning: E-337 is not applied here — only the holiday log will be created");
  for (const pass of [1, 2]) {
    await sql.begin((tx) => tx.unsafe(file));
    console.log(`pass ${pass}: ok`);
  }
} finally {
  await sql.end();
}

const check = postgres(url, opts);
try {
  for (const t of ["lead_limit_events", "holiday_calendar_log"]) {
    const [r] = await check`SELECT to_regclass(${"public." + t}) IS NOT NULL AS ok`;
    if (!r.ok) throw new Error(`✗ ${t} missing`);
  }
  const [c] = await check`
    SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
     WHERE conname = 'lead_clocks_clock_check'`;
  if (c && !String(c.def).includes("hot_owner")) throw new Error("✗ lead_clocks_clock_check not widened");
  const [n] = await check`SELECT count(*)::int AS n, count(*) FILTER (WHERE owner_inferred)::int AS inferred FROM lead_limit_events`;
  console.log(`lead_limit_events: ${n.n} rows (${n.inferred} with the owner not on record) — run scripts/refresh-lead-clocks.ts to record the misses so far`);
  console.log("✓ E-343 applied");
} finally {
  await check.end();
}
