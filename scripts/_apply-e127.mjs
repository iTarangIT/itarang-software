import { readFileSync } from "node:fs";
import postgres from "postgres";

const env = readFileSync(".env.local", "utf8");
const m = env.match(/^DATABASE_URL=(.*)$/m);
if (!m) { console.error("DATABASE_URL not found"); process.exit(1); }
const url = m[1].trim().replace(/^["']|["']$/g, "");

const migration = readFileSync("drizzle/E-127_onboarding_application_part0_columns.sql", "utf8");

const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 15 });
try {
  console.log("HOST:", new URL(url).hostname);
  await sql.unsafe(migration);
  const r = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'dealer_onboarding_applications'
      AND column_name IN ('originating_dealer_lead_id','proposed_deal_value','quote_document_url','payment_method')
    ORDER BY column_name`;
  console.log("E-127 applied. Verified columns:", r.map(x => x.column_name).join(", "));
} finally {
  await sql.end();
}
