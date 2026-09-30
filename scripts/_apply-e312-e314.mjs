// One-off: apply E-312, E-313, E-314 to database-1 (sandbox) or database-2 (prod).
//   node scripts/_apply-e312-e314.mjs database-1
//   node scripts/_apply-e312-e314.mjs database-2
// Reads that host's URL from .env.local (commented or not), never prints it.
// Each file runs twice (second pass must be a no-op), then everything is verified.
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
  "drizzle/E-312_data_download_log.sql",
  "drizzle/E-313_dealer_agreement_documents.sql",
  "drizzle/E-314_lead_events_wave3.sql",
];

for (const f of FILES) {
  const ddl = readFileSync(f, "utf8");
  for (const pass of [1, 2]) {
    const sql = postgres(url, { max: 1, ssl: { rejectUnauthorized: false }, onnotice: () => {} });
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(ddl);
      });
      console.log(`${f.split("/")[1]} pass ${pass}: ok`);
    } finally {
      await sql.end();
    }
  }
}

const v = postgres(url, { max: 1, ssl: { rejectUnauthorized: false } });
const tables = await v`
  SELECT to_regclass('public.data_download_log') IS NOT NULL AS e312,
         to_regclass('public.dealer_agreement_documents') IS NOT NULL AS e313,
         to_regclass('public.acquisition_campaigns') IS NOT NULL AS acq`;
const cols = await v`
  SELECT table_name, column_name FROM information_schema.columns
   WHERE (table_name = 'dealer_leads' AND column_name IN ('won_at','won_without_approved_quote','competitor_name','contactability',
          'contactability_at','contactability_reason','sales_ready_at','sales_ready_reason','source_door','source_origin',
          'acquisition_campaign_id','onboarding_docs_submitted_at','agreement_outcome','onboarding_stalled_at'))
      OR (table_name = 'dealer_lead_commercials' AND column_name IN ('withdrawn_by','withdraw_reason'))
      OR (table_name = 'lead_touchpoints' AND column_name IN ('screenshot_sha256','called_on_behalf'))`;
const trg = await v`SELECT tgname FROM pg_trigger WHERE tgname = 'dealer_leads_source_door'`;
const doors = await v`SELECT source_door, COUNT(*)::int n FROM dealer_leads GROUP BY 1 ORDER BY 2 DESC`;
console.log("tables:", tables[0]);
console.log(`E-314 columns: ${cols.length} of 18`);
console.log("source_door trigger:", trg.length ? "present" : "MISSING");
console.table(doors);
await v.end();
