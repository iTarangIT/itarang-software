// One-off: apply E-334 (account_order_claims + account_reminder_log — ID 5 "Order placed" and reorder reminders) to
// database-1 (sandbox) or database-2 (prod).
//
//   node scripts/_apply-e334.mjs database-1
//   node scripts/_apply-e334.mjs database-2
//
// DDL, additive. Reads that host's URL from .env.local (commented or not),
// never prints it. Applies the file twice (the second pass must be a no-op),
// then checks on a FRESH connection that the table and its columns exist —
// postgres.js DDL is not undone by a rollback, so the check is a real one.
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

const file = readFileSync("drizzle/E-334_account_order_claims_and_reminders.sql", "utf8");
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
  const expect = {
    account_order_claims: ["id", "account_id", "order_date", "po_number", "note", "claimed_by", "claimed_at", "withdrawn_at", "withdrawn_by", "withdrawn_reason"],
    account_reminder_log: ["kind", "period_key", "recipient", "dealers", "sent_at"],
  };
  for (const [table, want] of Object.entries(expect)) {
    const cols = (await check`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = ${table} ORDER BY ordinal_position`).map((r) => r.column_name);
    console.log(`${table} columns:`, cols.join(", "));
    for (const c of want) if (!cols.includes(c)) throw new Error(`✗ ${table}.${c} missing`);
  }
  const [idx] = await check`SELECT to_regclass('public.account_order_claims_account_idx') IS NOT NULL AS ok`;
  if (!idx.ok) throw new Error("✗ index account_order_claims_account_idx missing");
  console.log("✓ E-334 applied");
} finally {
  await check.end();
}
