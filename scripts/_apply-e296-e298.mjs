/**
 * Apply E-296 / E-297 / E-298 (Pile B workpack).
 *
 * Refuses to run against database-2 (PRODUCTION) unless --allow-prod is passed.
 *
 * Usage:
 *   node --env-file=.env.test.local scripts/_apply-e296-e298.mjs            # db-1 (sandbox)
 *   node --env-file=.env.test.local scripts/_apply-e296-e298.mjs --verify-only
 *
 * Every file is additive and idempotent, so re-running is the idempotency check.
 */
import { readFileSync } from "node:fs";
import postgres from "postgres";

const FILES = [
  "drizzle/E-296_dealer_leads_business_type.sql",
  "drizzle/E-297_quotation_cc.sql",
  "drizzle/E-298_loan_sanction_dealer_payment_confirmation.sql",
];
const EXPECTED = [
  ["dealer_leads", "business_type"],
  ["quotation_dispatches", "cc_recipients"],
  ["loan_sanctions", "dealer_payment_status"],
  ["loan_sanctions", "dealer_payment_confirmed_at"],
  ["loan_sanctions", "dealer_payment_confirmed_by"],
  ["loan_sanctions", "dealer_payment_utr"],
  ["loan_sanctions", "dealer_payment_amount"],
  ["loan_sanctions", "dealer_payment_remarks"],
  ["loan_sanctions", "dealer_payment_reminded_at"],
];

const verifyOnly = process.argv.includes("--verify-only");
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}
const host = new URL(url).host;
if (host.startsWith("database-2") && !process.argv.includes("--allow-prod")) {
  console.error(`> refusing: ${host} is PRODUCTION (pass --allow-prod to override)`);
  process.exit(1);
}

const sql = postgres(url, { ssl: { rejectUnauthorized: false }, max: 1, idle_timeout: 5 });
try {
  console.log(`> target host: ${host}`);
  if (!verifyOnly) {
    for (const f of FILES) {
      console.log(`> applying ${f}`);
      await sql.unsafe(`BEGIN;\n${readFileSync(f, "utf8")}\nCOMMIT;`).simple();
    }
    console.log("> ok — applied");
  }
  let bad = 0;
  for (const [table, column] of EXPECTED) {
    const r = await sql`
      SELECT 1 FROM information_schema.columns WHERE table_name = ${table} AND column_name = ${column}`;
    console.log(`  ${r.length ? "✔" : "✘"} ${table}.${column}`);
    if (!r.length) bad++;
  }
  console.log(bad ? `> ${bad} column(s) missing` : "> all columns present");
  process.exitCode = bad ? 1 : 0;
} finally {
  await sql.end();
}
