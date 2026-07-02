// Inspect the YOGENDRA TYAGI WhatsApp-onboarded dealer application and every
// related row across child tables. READ-ONLY — no writes.
//
// Usage: node scripts/_inspect-yogendra-app.mjs
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
function loadEnv(p){ if(!existsSync(p))return; for(const l of readFileSync(p,"utf8").split(/\r?\n/)){const t=l.trim();if(!t||t.startsWith("#"))continue;const i=t.indexOf("=");if(i<0)continue;const k=t.slice(0,i).trim();let v=t.slice(i+1).trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);if(!(k in process.env))process.env[k]=v;}}
loadEnv(join(ROOT,".env.local"));

const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const host = (process.env.DATABASE_URL || "").replace(/.*@/, "").split(/[:/]/)[0];
console.log(`Host: ${host}\n`);

// Locate the application — match by id prefix, GST, or owner name.
const apps = (await c.query(
  `SELECT id, company_name, owner_name, owner_phone, owner_email, wa_phone, gst_number,
          source, onboarding_status, review_status, agreement_status, submitted_at
     FROM dealer_onboarding_applications
    WHERE id::text LIKE '69687e54%'`,
)).rows;

console.log(`Matched applications: ${apps.length}`);
console.table(apps.map(a => ({ id: a.id, owner: a.owner_name, company: a.company_name, wa_phone: a.wa_phone, gst: a.gst_number, source: a.source, onb: a.onboarding_status, rev: a.review_status, agr: a.agreement_status })));

if (apps.length !== 1) {
  console.log("\n⚠ Expected exactly 1 match. Not proceeding to relation dump; refine the filter.");
  await c.end(); process.exit(apps.length === 0 ? 1 : 0);
}
const app = apps[0];
const APP_ID = app.id;
const WA = app.wa_phone;
console.log(`\nTarget APP_ID = ${APP_ID}   wa_phone = ${WA}\n`);

async function tableExists(t){ return (await c.query(`SELECT to_regclass($1) AS r`, [t])).rows[0].r !== null; }
async function count(label, table, where, params){
  if(!(await tableExists(table))){ console.log(`  [skip] ${table} (does not exist on this DB)`); return; }
  const n = (await c.query(`SELECT count(*)::int n FROM ${table} WHERE ${where}`, params)).rows[0].n;
  console.log(`  ${label.padEnd(38)} ${n}`);
}

console.log("Related rows keyed by application_id:");
await count("dealer_onboarding_documents", "dealer_onboarding_documents", "application_id=$1", [APP_ID]);
await count("dealer_agreement_signers", "dealer_agreement_signers", "application_id=$1", [APP_ID]);
await count("dealer_agreement_events", "dealer_agreement_events", "application_id=$1", [APP_ID]);
await count("whatsapp_onboarding_sessions", "whatsapp_onboarding_sessions", "application_id=$1", [APP_ID]);
await count("dealer_correction_rounds", "dealer_correction_rounds", "application_id=$1", [APP_ID]);
await count("dealers (application_id)", "dealers", "application_id=$1", [APP_ID]);
await count("dealer_leads (onboarding app id)", "dealer_leads", "dealer_onboarding_application_id=$1", [APP_ID]);

// correction items via rounds
if (await tableExists("dealer_correction_rounds")) {
  const items = (await c.query(
    `SELECT count(*)::int n FROM dealer_correction_items
      WHERE round_id IN (SELECT id FROM dealer_correction_rounds WHERE application_id=$1)`, [APP_ID])).rows[0].n;
  console.log(`  dealer_correction_items (via rounds)   ${items}`);
}

console.log("\nRelated rows keyed by wa_phone:");
if (WA) {
  await count("whatsapp_onboarding_sessions (phone)", "whatsapp_onboarding_sessions", "wa_phone=$1", [WA]);
  await count("whatsapp_dealer_sessions (phone)", "whatsapp_dealer_sessions", "wa_phone=$1", [WA]);
  // whatsapp_messages link to sessions, not directly to app; report by session
  if (await tableExists("whatsapp_messages")) {
    const m = (await c.query(
      `SELECT count(*)::int n FROM whatsapp_messages
        WHERE session_id IN (SELECT id FROM whatsapp_onboarding_sessions WHERE wa_phone=$1)
           OR dealer_session_id IN (SELECT id FROM whatsapp_dealer_sessions WHERE wa_phone=$1)`, [WA])).rows[0].n;
    console.log(`  whatsapp_messages (via sessions)       ${m}`);
  }
} else {
  console.log("  (no wa_phone on the application row)");
}

// Did approval create a users/accounts row? Probe by owner email/phone.
console.log("\nPossible login artifacts (owner email/phone):");
if (await tableExists("users")) {
  const u = (await c.query(
    `SELECT id, email, role FROM users WHERE lower(email)=lower($1) OR phone=$2 OR mobile=$2`.replace(/ OR (phone|mobile)=\$2/g, ""), // guard unknown cols
    [app.owner_email || "", app.owner_phone || ""]).catch(()=>({rows:[]}))).rows;
  console.log(`  users matching owner_email: ${u.length}`);
  if (u.length) console.table(u);
}
if (await tableExists("accounts")) {
  const acc = (await c.query(
    `SELECT id, name FROM accounts WHERE gst_number=$1 OR upper(name) LIKE $2`.replace(/gst_number=\$1 OR /,""), // accounts may not have gst_number; fall back to name
    [`%${(app.company_name||"").toUpperCase()}%`]).catch(()=>({rows:[]}))).rows;
  console.log(`  accounts matching company name: ${acc.length}`);
  if (acc.length) console.table(acc);
}

await c.end();
console.log("\nRead-only inspection complete.");
