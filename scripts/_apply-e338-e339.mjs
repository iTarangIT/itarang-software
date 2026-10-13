// One-off: apply E-338 (reporting-line history — ID 155) and E-339 (KYC file
// open log — ID 166) to database-1 (sandbox) or database-2 (prod).
//
//   node scripts/_apply-e338-e339.mjs database-1
//   node scripts/_apply-e338-e339.mjs database-2
//
// DDL, additive. Reads that host's URL from .env.local (commented or not),
// never prints it. Refuses E-338 unless E-335 (users.reports_to) is there.
// Applies each file twice (the second pass must be a no-op), then checks on a
// FRESH connection that the tables and indexes exist.
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

const opts = { max: 1, prepare: false, ssl: { rejectUnauthorized: false } };
const files = ["drizzle/E-338_user_reporting_line_history.sql", "drizzle/E-339_file_access_log.sql"];

const sql = postgres(url, { ...opts, onnotice: (n) => console.log("notice:", n.message) });
try {
  const [pre] = await sql`
    SELECT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema='public' AND table_name='users' AND column_name='reports_to') AS ok`;
  if (!pre.ok) throw new Error("E-335 (users.reports_to) missing — apply it first");
  for (const f of files) {
    const body = readFileSync(f, "utf8");
    for (const pass of [1, 2]) {
      await sql.begin((tx) => tx.unsafe(body));
      console.log(`${f.split("/")[1]} pass ${pass}: ok`);
    }
  }
} finally {
  await sql.end();
}

const check = postgres(url, opts);
try {
  for (const rel of [
    "user_reporting_lines",
    "user_reporting_lines_one_open_uq",
    "user_reporting_lines_manager_open_idx",
    "user_reporting_lines_user_from_idx",
    "file_access_log",
    "file_access_log_opened_idx",
    "file_access_log_lead_idx",
    "file_access_log_user_idx",
  ]) {
    const [r] = await check`SELECT to_regclass(${"public." + rel}) IS NOT NULL AS ok`;
    if (!r.ok) throw new Error(`✗ ${rel} missing`);
  }
  const [a] = await check`SELECT count(*)::int AS n FROM user_reporting_lines`;
  const [b] = await check`SELECT count(*)::int AS n FROM users WHERE reports_to IS NOT NULL AND reports_to <> id`;
  console.log(`user_reporting_lines rows: ${a.n} (users with a manager: ${b.n})`);
  console.log("✓ E-338 + E-339 applied");
} finally {
  await check.end();
}
