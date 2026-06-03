import { readFileSync } from "node:fs";
import postgres from "postgres";

const env = readFileSync(".env.local", "utf8");
const m = env.match(/^DATABASE_URL=(.*)$/m);
if (!m) { console.error("DATABASE_URL not found"); process.exit(1); }
const url = m[1].trim().replace(/^["']|["']$/g, "");

const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 15 });
try {
  const host = new URL(url).hostname;
  console.log("HOST:", host);

  // Columns E-127 should have added to dealer_onboarding_applications
  const wantCols = [
    "originating_dealer_lead_id","sponsoring_asm_id","owner_id","field_verification_status",
    "source_ai_session_id","source_ai_intent_score","source_ai_recording_url","payment_intent_note",
    "communication_language","business_segments","proposed_deal_value","proposed_credit_terms",
    "proposed_delivery_terms","proposed_warranty_terms","proposed_terms_notes","payment_method",
    "deal_notes","quote_document_url",
  ];
  const have = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'dealer_onboarding_applications'`;
  const haveSet = new Set(have.map(r => r.column_name));
  const missing = wantCols.filter(c => !haveSet.has(c));
  console.log("E-127 missing columns:", missing.length ? missing.join(", ") : "(none — already applied)");

  // dialer_campaign_leads table presence (E-109)
  const t = await sql`SELECT to_regclass('public.dialer_campaign_leads') AS r`;
  console.log("dialer_campaign_leads table:", t[0].r ? "exists" : "MISSING (E-109 unapplied)");
  const t2 = await sql`SELECT to_regclass('public.dialer_campaigns') AS r`;
  console.log("dialer_campaigns table:", t2[0].r ? "exists" : "MISSING (E-109 unapplied)");
} finally {
  await sql.end();
}
