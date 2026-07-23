// READ-ONLY: inventory everything linked to a dealer_onboarding_applications
// row, so we know exactly what a delete would touch. No writes.
//   node scripts/_inspect-dealer.mjs <application_id>
import { readFileSync } from "node:fs";
import postgres from "postgres";

const APP_ID = process.argv[2];
if (!APP_ID) { console.error("usage: node scripts/_inspect-dealer.mjs <application_id>"); process.exit(1); }

const env = readFileSync(".env.local", "utf8");
const m = env.match(/^DATABASE_URL=(.*)$/m);
if (!m) { console.error("DATABASE_URL not found"); process.exit(1); }
const url = m[1].trim().replace(/^["']|["']$/g, "");
const host = (url.match(/@([^:/]+)/) || [])[1];
console.log("Host:", host, "\nApp:", APP_ID, "\n");

const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 15 });
try {
  const app = await sql`
    SELECT id, company_name, owner_name, wa_phone, wa_session_id, source,
           onboarding_status, review_status, created_at
    FROM dealer_onboarding_applications WHERE id = ${APP_ID}`;
  if (!app.length) { console.log("No application with that id."); process.exit(0); }
  console.log("APPLICATION:", app[0]);
  const phone = app[0].wa_phone;

  const sessionsByApp = await sql`
    SELECT id, wa_phone, current_state, session_status, created_at
    FROM whatsapp_onboarding_sessions WHERE application_id = ${APP_ID}`;
  const sessionsByPhone = phone ? await sql`
    SELECT id, wa_phone, application_id, current_state, session_status, created_at
    FROM whatsapp_onboarding_sessions WHERE wa_phone = ${phone}
    ORDER BY created_at DESC` : [];
  console.log(`\nSESSIONS by application_id (${sessionsByApp.length}):`, sessionsByApp);
  console.log(`SESSIONS by wa_phone=${phone} (${sessionsByPhone.length}):`, sessionsByPhone);

  const sessIds = [...new Set([...sessionsByApp, ...sessionsByPhone].map((s) => s.id))];
  const msgCount = sessIds.length
    ? await sql`SELECT count(*)::int AS n FROM whatsapp_messages WHERE session_id = ANY(${sessIds})`
    : [{ n: 0 }];

  const docs = await sql`SELECT count(*)::int AS n FROM dealer_onboarding_documents WHERE application_id = ${APP_ID}`;
  const signers = await sql`SELECT count(*)::int AS n FROM dealer_agreement_signers WHERE application_id = ${APP_ID}`;
  const events = await sql`SELECT count(*)::int AS n FROM dealer_agreement_events WHERE application_id = ${APP_ID}`;
  let leads = [];
  try { leads = await sql`SELECT id FROM leads WHERE dealer_onboarding_application_id = ${APP_ID}`; }
  catch (e) { leads = [{ note: "leads check skipped: " + e.code }]; }
  const dealerSess = phone ? await sql`SELECT id, dealer_code, session_status FROM whatsapp_dealer_sessions WHERE wa_phone = ${phone}` : [];

  console.log("\nRELATED ROW COUNTS:");
  console.log("  whatsapp_messages (for those sessions):", msgCount[0].n);
  console.log("  dealer_onboarding_documents:", docs[0].n);
  console.log("  dealer_agreement_signers:", signers[0].n);
  console.log("  dealer_agreement_events:", events[0].n);
  console.log("  leads (dealer_onboarding_application_id):", leads.length, leads);
  console.log("  whatsapp_dealer_sessions (same phone, post-approval):", dealerSess.length, dealerSess);
} finally {
  await sql.end();
}
