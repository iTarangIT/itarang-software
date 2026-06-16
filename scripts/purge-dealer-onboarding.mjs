// Purge a single dealer onboarding application and everything created from it,
// so the same WhatsApp number can onboard again from scratch.
//
// Deletes (FK-safe order, one transaction):
//   whatsapp_messages → whatsapp_onboarding_sessions →
//   dealer_agreement_events / dealer_agreement_signers /
//   dealer_correction_rounds / dealer_onboarding_documents →
//   dealers (by application_id) → dealer_onboarding_applications →
//   users (the dealer login row)
// Then deletes the Supabase Auth user (frees the email for re-activation).
//
// SAFE BY DEFAULT: prints a dry-run summary. Pass --confirm to actually delete.
//
//   node scripts/purge-dealer-onboarding.mjs <applicationId>            # dry run
//   node scripts/purge-dealer-onboarding.mjs <applicationId> --confirm  # delete

import { readFileSync } from "node:fs";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";

const APP_ID = process.argv[2];
const CONFIRM = process.argv.includes("--confirm");
if (!APP_ID) {
  console.error("Usage: node scripts/purge-dealer-onboarding.mjs <applicationId> [--confirm]");
  process.exit(1);
}

function envVal(name) {
  const lines = readFileSync(".env.local", "utf8").split(/\r?\n/);
  for (const l of lines) {
    if (l.trim().startsWith("#")) continue;
    const m = l.match(new RegExp(`^${name}=(.+)$`));
    if (m) return m[1].trim().replace(/^"(.*)"$/, "$1");
  }
  return null;
}

const DB_URL = (envVal("DATABASE_URL") || "").replace(/\?.*$/, "");
const SUPABASE_URL = envVal("SUPABASE_URL") || envVal("NEXT_PUBLIC_SUPABASE_URL");
const SERVICE_ROLE = envVal("SUPABASE_SERVICE_ROLE_KEY");

const c = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
await c.connect();

// ---- Discover everything tied to this application -------------------------
const appRes = await c.query(
  `SELECT id, company_name, owner_email, wa_phone, wa_session_id, dealer_user_id
   FROM dealer_onboarding_applications WHERE id=$1`,
  [APP_ID],
);
if (appRes.rows.length === 0) {
  console.error(`No application ${APP_ID} found. Nothing to do.`);
  await c.end();
  process.exit(1);
}
const app = appRes.rows[0];

// session ids (by application_id OR the wa_session_id stored on the app)
const sessRes = await c.query(
  `SELECT id FROM whatsapp_onboarding_sessions WHERE application_id=$1 OR id=$2`,
  [APP_ID, app.wa_session_id],
);
const sessionIds = sessRes.rows.map((r) => r.id);

const dealerRes = await c.query(`SELECT id FROM dealers WHERE application_id=$1`, [APP_ID]);
const dealerIds = dealerRes.rows.map((r) => r.id);

console.log("================ PURGE PLAN ================");
console.log(`application      : ${app.id}  (${app.company_name})`);
console.log(`wa_phone         : ${app.wa_phone}`);
console.log(`dealer login user: ${app.dealer_user_id ?? "(none)"}  <${app.owner_email}>`);
console.log(`wa sessions      : ${sessionIds.length} -> ${sessionIds.join(", ") || "(none)"}`);
console.log(`dealers rows     : ${dealerIds.length} -> ${dealerIds.join(", ") || "(none)"}`);
console.log("===========================================");

// ---- Helper: delete + report ----------------------------------------------
async function del(sql, params, label) {
  const r = await c.query(sql, params);
  console.log(`  ${label}: ${r.rowCount} deleted`);
  return r.rowCount;
}

if (!CONFIRM) {
  // Dry run: count what WOULD be deleted, no writes.
  console.log("\n--- DRY RUN (no --confirm): counts only, nothing deleted ---");
  const counts = [
    ["whatsapp_messages", sessionIds.length ? `SELECT count(*) n FROM whatsapp_messages WHERE session_id = ANY($1)` : null, [sessionIds]],
    ["whatsapp_onboarding_sessions", `SELECT count(*) n FROM whatsapp_onboarding_sessions WHERE application_id=$1 OR id=$2`, [APP_ID, app.wa_session_id]],
    ["dealer_agreement_events", `SELECT count(*) n FROM dealer_agreement_events WHERE application_id=$1`, [APP_ID]],
    ["dealer_agreement_signers", `SELECT count(*) n FROM dealer_agreement_signers WHERE application_id=$1`, [APP_ID]],
    ["dealer_correction_rounds", `SELECT count(*) n FROM dealer_correction_rounds WHERE application_id=$1`, [APP_ID]],
    ["dealer_onboarding_documents", `SELECT count(*) n FROM dealer_onboarding_documents WHERE application_id=$1`, [APP_ID]],
    ["dealers", `SELECT count(*) n FROM dealers WHERE application_id=$1`, [APP_ID]],
    ["dealer_onboarding_applications", `SELECT count(*) n FROM dealer_onboarding_applications WHERE id=$1`, [APP_ID]],
    ["users (login)", app.dealer_user_id ? `SELECT count(*) n FROM users WHERE id=$1` : null, [app.dealer_user_id]],
  ];
  for (const [label, sql, params] of counts) {
    if (!sql) { console.log(`  ${label}: 0 (skipped)`); continue; }
    const r = await c.query(sql, params);
    console.log(`  ${label}: ${r.rows[0].n} would be deleted`);
  }
  console.log(`\n  + Supabase Auth user ${app.dealer_user_id ?? "(none)"} would be deleted`);
  console.log("\nRe-run with --confirm to delete.");
  await c.end();
  process.exit(0);
}

// ---- Real delete, one transaction, children first -------------------------
try {
  await c.query("BEGIN");
  if (sessionIds.length)
    await del(`DELETE FROM whatsapp_messages WHERE session_id = ANY($1)`, [sessionIds], "whatsapp_messages");
  await del(`DELETE FROM whatsapp_onboarding_sessions WHERE application_id=$1 OR id=$2`, [APP_ID, app.wa_session_id], "whatsapp_onboarding_sessions");
  await del(`DELETE FROM dealer_agreement_events WHERE application_id=$1`, [APP_ID], "dealer_agreement_events");
  await del(`DELETE FROM dealer_agreement_signers WHERE application_id=$1`, [APP_ID], "dealer_agreement_signers");
  await del(`DELETE FROM dealer_correction_rounds WHERE application_id=$1`, [APP_ID], "dealer_correction_rounds");
  await del(`DELETE FROM dealer_onboarding_documents WHERE application_id=$1`, [APP_ID], "dealer_onboarding_documents");
  await del(`DELETE FROM dealers WHERE application_id=$1`, [APP_ID], "dealers");
  await del(`DELETE FROM dealer_onboarding_applications WHERE id=$1`, [APP_ID], "dealer_onboarding_applications");
  if (app.dealer_user_id)
    await del(`DELETE FROM users WHERE id=$1`, [app.dealer_user_id], "users (login)");
  await c.query("COMMIT");
  console.log("\nDB transaction committed.");
} catch (e) {
  await c.query("ROLLBACK");
  console.error("\nDB delete FAILED — rolled back, nothing changed:", e.message);
  await c.end();
  process.exit(1);
}
await c.end();

// ---- Supabase Auth user (separate system) ---------------------------------
if (app.dealer_user_id && SUPABASE_URL && SERVICE_ROLE) {
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
  const { error } = await admin.auth.admin.deleteUser(app.dealer_user_id);
  if (error) console.error(`Supabase auth deleteUser failed (delete manually): ${error.message}`);
  else console.log(`Supabase Auth user ${app.dealer_user_id} deleted.`);
} else if (app.dealer_user_id) {
  console.warn("Supabase URL/service-role not found in .env.local — delete the auth user manually.");
}
console.log("\nDone. The number can now onboard fresh via WhatsApp.");
