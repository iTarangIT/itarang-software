// One-off: apply E-363 (verified visits, ID 196), E-364 (expense claim days,
// ID 197) and E-365 (EMI customer messages, ID 204) — in that order — to
// database-1 (sandbox) or database-2 (prod).
//
//   node scripts/_apply-e363-e365.mjs database-1
//   node scripts/_apply-e363-e365.mjs database-2
//
// All three are additive and not mirrored in schema.ts. Reads that host's URL
// from .env.local (commented or not), never prints it. Applies each file twice
// (the second pass must be a no-op), then re-checks tables, columns, indexes
// and checks on a FRESH connection.
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

const FILES = [
  "drizzle/E-363_verified_visits.sql",
  "drizzle/E-364_expense_claim_days.sql",
  "drizzle/E-365_emi_customer_messages.sql",
];
const opts = { max: 1, prepare: false, ssl: { rejectUnauthorized: false } };

const sql = postgres(url, { ...opts, onnotice: (n) => console.log("notice:", n.message) });
try {
  for (const f of FILES) {
    const file = readFileSync(f, "utf8");
    for (const pass of [1, 2]) {
      await sql.begin((tx) => tx.unsafe(file));
      console.log(`${f.split("/")[1]} pass ${pass}: ok`);
    }
  }
} finally {
  await sql.end();
}

const check = postgres(url, opts);
const fail = (m) => {
  throw new Error(m);
};
try {
  const tables = await check`
    SELECT t, to_regclass('public.' || t) IS NOT NULL AS ok
      FROM unnest(ARRAY['visit_captures', 'expense_claim_days', 'emi_customer_messages']) AS t`;
  console.table(tables);
  if (tables.some((r) => !r.ok)) fail("a table is missing");

  const lv = await check`
    SELECT column_name, data_type, is_nullable FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'lead_visits'
       AND column_name IN ('account_id', 'gps_accuracy_m', 'captured_at', 'photo_sha256', 'capture_id', 'verified', 'dealer_lead_id')
     ORDER BY column_name`;
  console.table(lv);
  if (lv.length !== 7) fail(`lead_visits: expected 7 columns, found ${lv.length}`);
  if (lv.find((c) => c.column_name === "dealer_lead_id")?.is_nullable !== "YES") fail("lead_visits.dealer_lead_id still NOT NULL");

  const ix = await check`
    SELECT indexname FROM pg_indexes
     WHERE indexname IN ('visit_captures_photo_sha256_key', 'lead_visits_photo_sha256_key', 'lead_visits_account_idx',
                         'lead_visits_asm_actual_idx', 'expense_claim_days_user_day_idx', 'expense_claim_days_expense_day_key',
                         'emi_customer_messages_once_key', 'emi_customer_messages_provider_idx')
     ORDER BY 1`;
  console.log("indexes:", ix.map((r) => r.indexname).join(", "));
  if (ix.length !== 8) fail(`expected 8 indexes, found ${ix.length}`);

  const ck = await check`
    SELECT conname FROM pg_constraint
     WHERE conname IN ('lead_visits_lead_or_account_chk', 'expense_claim_days_verdict_chk',
                       'emi_customer_messages_kind_chk', 'emi_customer_messages_channel_chk')
     ORDER BY 1`;
  console.log("checks:", ck.map((r) => r.conname).join(", "));
  if (ck.length !== 4) fail(`expected 4 checks, found ${ck.length}`);

  const [counts] = await check`
    SELECT (SELECT count(*)::int FROM lead_visits) AS lead_visits,
           (SELECT count(*)::int FROM lead_visits WHERE verified) AS verified_visits`;
  console.log(`lead_visits rows: ${counts.lead_visits} (verified: ${counts.verified_visits})`);
  console.log("E-363, E-364, E-365 verified");
} finally {
  await check.end();
}
