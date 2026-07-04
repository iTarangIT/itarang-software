// Delete the YOGENDRA TYAGI *WhatsApp* dealer onboarding application
// (id 69687e54-25e1-48ff-90e9-f40649c6506f, wa_phone 918208677782) and all its
// child rows, so it can be re-onboarded. Scoped strictly to this application id
// and its unique phone — the separate WEB application (acfc1128…) sharing the
// same GST is NOT touched.
//
// Usage:
//   node scripts/_delete-yogendra-whatsapp-app.mjs --dry   # preview counts
//   node scripts/_delete-yogendra-whatsapp-app.mjs         # apply (transaction)
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
function loadEnv(p){ if(!existsSync(p))return; for(const l of readFileSync(p,"utf8").split(/\r?\n/)){const t=l.trim();if(!t||t.startsWith("#"))continue;const i=t.indexOf("=");if(i<0)continue;const k=t.slice(0,i).trim();let v=t.slice(i+1).trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);if(!(k in process.env))process.env[k]=v;}}
loadEnv(join(ROOT,".env.local"));

const DRY = process.argv.includes("--dry");
const APP_ID = "69687e54-25e1-48ff-90e9-f40649c6506f";
const WA = "918208677782";

const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const host = (process.env.DATABASE_URL || "").replace(/.*@/, "").split(/[:/]/)[0];
console.log(`Host: ${host}`);
console.log(`Mode: ${DRY ? "DRY-RUN (no writes)" : "APPLY"}`);
console.log(`Target: app=${APP_ID}  wa_phone=${WA}\n`);

// Safety: confirm the target row is the WhatsApp one before deleting anything.
const [app] = (await c.query(
  `SELECT id, owner_name, company_name, source, wa_phone
     FROM dealer_onboarding_applications WHERE id=$1`, [APP_ID])).rows;
if (!app) { console.error("Target application not found — already deleted?"); await c.end(); process.exit(1); }
if (app.source !== "whatsapp" || app.wa_phone !== WA) {
  console.error(`Refusing: row is not the expected WhatsApp app (source=${app.source}, wa_phone=${app.wa_phone}).`);
  await c.end(); process.exit(1);
}
console.log(`Confirmed target: ${app.owner_name} / ${app.company_name} (source=${app.source})\n`);

async function tableExists(t){ return (await c.query(`SELECT to_regclass($1) AS r`, [t])).rows[0].r !== null; }

// Ordered deletes (children first). Each entry: [label, sql, params].
const steps = [
  // whatsapp_messages tied to THIS phone's onboarding session(s)
  ["whatsapp_messages (this phone's sessions)",
    `DELETE FROM whatsapp_messages
      WHERE session_id IN (SELECT id FROM whatsapp_onboarding_sessions WHERE wa_phone=$1 OR application_id=$2)`,
    [WA, APP_ID]],
  ["whatsapp_onboarding_sessions",
    `DELETE FROM whatsapp_onboarding_sessions WHERE application_id=$1 OR wa_phone=$2`, [APP_ID, WA]],
  ["dealer_correction_items (via rounds)",
    `DELETE FROM dealer_correction_items
      WHERE round_id IN (SELECT id FROM dealer_correction_rounds WHERE application_id=$1)`, [APP_ID]],
  ["dealer_correction_rounds",
    `DELETE FROM dealer_correction_rounds WHERE application_id=$1`, [APP_ID]],
  ["dealer_onboarding_documents",
    `DELETE FROM dealer_onboarding_documents WHERE application_id=$1`, [APP_ID]],
  ["dealer_agreement_events",
    `DELETE FROM dealer_agreement_events WHERE application_id=$1`, [APP_ID]],
  ["dealer_agreement_signers",
    `DELETE FROM dealer_agreement_signers WHERE application_id=$1`, [APP_ID]],
  ["dealers (approval artifact)",
    `DELETE FROM dealers WHERE application_id=$1`, [APP_ID]],
  ["dealer_onboarding_applications (the app)",
    `DELETE FROM dealer_onboarding_applications WHERE id=$1`, [APP_ID]],
];

// Preview counts for each step's WHERE.
console.log("Rows that will be deleted per table:");
for (const [label, sql, params] of steps) {
  const table = sql.match(/DELETE FROM (\w+)/)[1];
  if (!(await tableExists(table))) { console.log(`  [skip] ${label} — table ${table} absent`); continue; }
  const countSql = sql.replace(/^DELETE FROM \w+/, m => `SELECT count(*)::int n FROM ${m.replace("DELETE FROM ","")}`);
  const n = (await c.query(countSql, params)).rows[0].n;
  console.log(`  ${label.padEnd(42)} ${n}`);
}

if (DRY) { console.log("\nDRY-RUN — no writes. Re-run without --dry to apply."); await c.end(); process.exit(0); }

console.log("\nApplying in a transaction...");
await c.query("BEGIN");
try {
  for (const [label, sql, params] of steps) {
    const table = sql.match(/DELETE FROM (\w+)/)[1];
    if (!(await tableExists(table))) continue;
    const res = await c.query(sql, params);
    console.log(`  deleted ${String(res.rowCount).padStart(4)}  ${label}`);
  }
  await c.query("COMMIT");
  console.log("\n✓ COMMIT — WhatsApp application fully deleted. You can re-onboard now.");
} catch (e) {
  await c.query("ROLLBACK");
  console.error("\nROLLBACK — nothing deleted:", e.message);
  process.exit(1);
}
await c.end();
