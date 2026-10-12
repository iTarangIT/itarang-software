// One-off: apply E-336 (quote deal card — ID 172) to database-1 (sandbox) or
// database-2 (prod).
//
//   node scripts/_apply-e336.mjs database-1
//   node scripts/_apply-e336.mjs database-2
//
// DDL, additive. Reads that host's URL from .env.local (commented or not),
// never prints it. Applies the file twice (the second pass must be a no-op),
// then checks on a FRESH connection that the four columns and the CHECK exist.
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

const file = readFileSync("drizzle/E-336_quote_deal_card.sql", "utf8");
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

const COLS = ["onboarding_fee", "fee_waived_reason", "expected_batteries_per_month", "expected_finance_files_per_month"];
const check = postgres(url, opts);
try {
  const cols = await check`
    SELECT column_name, data_type FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'dealer_lead_commercials'
       AND column_name IN ${check(COLS)}`;
  for (const c of COLS) {
    const hit = cols.find((r) => r.column_name === c);
    if (!hit) throw new Error(`✗ dealer_lead_commercials.${c} missing`);
    console.log(`dealer_lead_commercials.${c}: ${hit.data_type}`);
  }
  const [con] = await check`SELECT 1 AS ok FROM pg_constraint WHERE conname = 'dlc_deal_card_ranges'`;
  if (!con) throw new Error("✗ constraint dlc_deal_card_ranges missing");
  console.log("✓ E-336 applied");
} finally {
  await check.end();
}
