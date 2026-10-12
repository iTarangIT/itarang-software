// One-off: apply E-337 (time limits + lead clocks — IDs 85, 86) to
// database-1 (sandbox) or database-2 (prod).
//
//   node scripts/_apply-e337.mjs database-1
//   node scripts/_apply-e337.mjs database-2
//
// DDL, additive. Reads that host's URL from .env.local (commented or not),
// never prints it. Applies the file twice (the second pass must be a no-op),
// then checks on a FRESH connection that both tables and their indexes exist —
// postgres.js DDL is not undone by a rollback, so the check is a real one.
// Afterwards: node --import tsx --env-file=<env> scripts/refresh-lead-clocks.ts
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

const file = readFileSync("drizzle/E-337_time_limits_and_lead_clocks.sql", "utf8");
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
    "time_limit_settings",
    "time_limit_settings_key_idx",
    "lead_clocks",
    "lead_clocks_lead_clock_start_uniq",
    "lead_clocks_started_idx",
    "lead_clocks_passed_idx",
  ]) {
    const [r] = await check`SELECT to_regclass(${"public." + rel}) IS NOT NULL AS ok`;
    if (!r.ok) throw new Error(`✗ ${rel} missing`);
  }
  const [s] = await check`SELECT count(*)::int AS n FROM time_limit_settings`;
  console.log(`time_limit_settings rows: ${s.n} (the carried-over ASM visit limit, if one was saved)`);
  console.log("✓ E-337 applied");
} finally {
  await check.end();
}
