// Apply the dealer-onboarding migrations that database-2 is missing.
//
// database-2 skipped E-164 (draft_step) and E-167 (WhatsApp onboarding columns
// + tables). The admin dealer-verification page does db.select() over every
// column schema.ts declares, so the query dies on `column "draft_step" does
// not exist` -> 500 -> "Dealer review data not found."
//
// Both files are strictly additive + idempotent (ADD COLUMN IF NOT EXISTS /
// CREATE TABLE IF NOT EXISTS), so re-running is a no-op. Run with:
//   node scripts/_apply-e164-e167.mjs
import { readFileSync } from "node:fs";
import postgres from "postgres";

const env = readFileSync(".env.local", "utf8");
const m = env.match(/^DATABASE_URL=(.*)$/m);
if (!m) { console.error("DATABASE_URL not found"); process.exit(1); }
const url = m[1].trim().replace(/^["']|["']$/g, "");
const host = (url.match(/@([^:/]+)/) || [])[1];
console.log("Applying E-164 + E-167 to host:", host);

const e164 = readFileSync("drizzle/E-164_dealer_onboarding_draft_step.sql", "utf8");
const e167 = readFileSync("drizzle/E-167_whatsapp_onboarding.sql", "utf8");

const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 15 });
try {
  await sql.unsafe(e164);
  console.log("E-164 applied OK");
  await sql.unsafe(e167);
  console.log("E-167 applied OK");

  const r = await sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'dealer_onboarding_applications'
      AND column_name IN ('draft_step','source','wa_phone','wa_session_id',
                          'verification_warnings','extraction_summary','dealer_confirmed_at')
    ORDER BY column_name`;
  console.log(
    "dealer_onboarding_applications now has:",
    r.map((x) => x.column_name).join(", ") || "(none — unexpected)",
  );
} finally {
  await sql.end();
}
