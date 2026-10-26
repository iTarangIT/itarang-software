// One-off: apply E-356 (account quotations) and E-357 (Accounts screen
// indexes) to database-1 (sandbox) or database-2 (prod).
//
//   node scripts/_apply-e356-e357.mjs database-1
//   node scripts/_apply-e356-e357.mjs database-2
//
// DDL, additive. Reads that host's URL from .env.local (commented or not),
// never prints it. Applies each file twice (the second pass must be a no-op),
// then checks on a FRESH connection.
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

const files = ["drizzle/E-356_account_quotations.sql", "drizzle/E-357_accounts_list_perf_indexes.sql"];
const opts = { max: 1, prepare: false, ssl: { rejectUnauthorized: false } };

const sql = postgres(url, { ...opts, onnotice: (n) => console.log("notice:", n.message) });
try {
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    for (const pass of [1, 2]) {
      await sql.begin((tx) => tx.unsafe(text));
      console.log(`${f} pass ${pass}: ok`);
    }
  }
} finally {
  await sql.end();
}

const check = postgres(url, opts);
try {
  for (const rel of [
    "account_quotations",
    "account_quotation_dispatches",
    "account_quotations_account_version_uniq",
    "dealer_onboarding_applications_dealer_code_idx",
    "dealer_leads_onboarding_application_idx",
    "dealer_leads_gstin_key_idx",
    "dealer_leads_phone_last10_idx",
  ]) {
    const [r] = await check`SELECT to_regclass(${"public." + rel}) IS NOT NULL AS ok`;
    console.log(`${r.ok ? "✓" : "✗"} ${rel}`);
    if (!r.ok) process.exitCode = 1;
  }
} finally {
  await check.end();
}
