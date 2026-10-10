// One-off: apply E-335 (users.reports_to — ID 155 reporting lines) to
// database-1 (sandbox) or database-2 (prod).
//
//   node scripts/_apply-e335.mjs database-1
//   node scripts/_apply-e335.mjs database-2
//
// DDL, additive. Reads that host's URL from .env.local (commented or not),
// never prints it. Applies the file twice (the second pass must be a no-op),
// then checks on a FRESH connection that the column, both constraints and the
// index exist — postgres.js DDL is not undone by a rollback, so the check is a
// real one.
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

const file = readFileSync("drizzle/E-335_user_reporting_lines.sql", "utf8");
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
  const [col] = await check`
    SELECT data_type, is_nullable FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'reports_to'`;
  if (!col) throw new Error("✗ users.reports_to missing");
  console.log(`users.reports_to: ${col.data_type}, nullable=${col.is_nullable}`);
  const cons = (await check`
    SELECT conname FROM pg_constraint
     WHERE conname IN ('users_reports_to_fkey', 'users_reports_to_not_self')`).map((r) => r.conname);
  for (const c of ["users_reports_to_fkey", "users_reports_to_not_self"]) if (!cons.includes(c)) throw new Error(`✗ constraint ${c} missing`);
  const [idx] = await check`SELECT to_regclass('public.users_reports_to_idx') IS NOT NULL AS ok`;
  if (!idx.ok) throw new Error("✗ index users_reports_to_idx missing");
  const [n] = await check`SELECT count(*)::int AS set FROM users WHERE reports_to IS NOT NULL`;
  console.log(`rows with reports_to set: ${n.set}`);
  console.log("✓ E-335 applied");
} finally {
  await check.end();
}
