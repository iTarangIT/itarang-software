// Enable finance for the dealer dashboard of kartik.itarang@gmail.com.
// The dashboard reads dealerApp.finance_enabled from dealer_onboarding_applications,
// resolved by findLatestDealerOnboardingApplication (dealer_user_id first, then
// owner_email, ordered by updated_at DESC). We replicate that EXACT resolution,
// show the row, and flip finance_enabled=true on that single row only.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
function loadEnv(p){ if(!existsSync(p))return; for(const l of readFileSync(p,"utf8").split(/\r?\n/)){const t=l.trim();if(!t||t.startsWith("#"))continue;const i=t.indexOf("=");if(i<0)continue;const k=t.slice(0,i).trim();let v=t.slice(i+1).trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);if(!(k in process.env))process.env[k]=v;}}
loadEnv(join(ROOT,".env.local"));
loadEnv(join(ROOT,".env"));

const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
console.log(`CRM host: ${(process.env.DATABASE_URL||"").replace(/.*@/,"").split(/[:/]/)[0]}`);
const EMAIL = "kartik.itarang@gmail.com";

// Resolve app user id (mirror route: users.id=auth.id OR users.email).
const u = (await c.query(`SELECT id, email, dealer_id FROM users WHERE lower(email)=lower($1) LIMIT 1`, [EMAIL])).rows[0];
console.log("app user:", JSON.stringify(u));
const candidateIds = [u?.id].filter(Boolean);

// Step 1: by dealer_user_id, latest by updated_at.
let app = null;
for (const cid of candidateIds) {
  const r = (await c.query(
    `SELECT id, company_name, owner_email, dealer_user_id, finance_enabled, onboarding_status, review_status, updated_at
     FROM dealer_onboarding_applications WHERE dealer_user_id=$1 ORDER BY updated_at DESC LIMIT 1`, [cid])).rows[0];
  if (r) { app = r; console.log("matched by dealer_user_id"); break; }
}
// Step 2: fallback by owner_email.
if (!app) {
  app = (await c.query(
    `SELECT id, company_name, owner_email, dealer_user_id, finance_enabled, onboarding_status, review_status, updated_at
     FROM dealer_onboarding_applications WHERE lower(owner_email)=lower($1) ORDER BY updated_at DESC LIMIT 1`, [EMAIL])).rows[0] ?? null;
  if (app) console.log("matched by owner_email fallback");
}

if (!app) { console.log("No dealer_onboarding_applications row resolves for this dealer. Aborting."); await c.end(); process.exit(1); }
console.log("\nRESOLVED ROW (this is what the dashboard reads):");
console.log(JSON.stringify(app));

if (app.finance_enabled === true) {
  console.log("\nAlready finance_enabled=true — no change needed.");
} else {
  const upd = (await c.query(
    `UPDATE dealer_onboarding_applications SET finance_enabled=true, updated_at=now()
     WHERE id=$1 RETURNING id, company_name, finance_enabled, updated_at`, [app.id]));
  console.log(`\nRows updated: ${upd.rowCount}`);
  console.log("AFTER:", JSON.stringify(upd.rows[0]));
}
await c.end();
