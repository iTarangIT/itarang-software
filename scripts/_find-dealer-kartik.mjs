// Locate dealer 'Test' / login kartik.itarang@gmail.com across the relevant
// tables and show current finance_enabled. READ-ONLY.
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

async function show(title, q, params){
  try { const r = await c.query(q, params); console.log(`\n=== ${title} (${r.rowCount}) ===`); for(const row of r.rows) console.log(JSON.stringify(row)); }
  catch(e){ console.log(`\n=== ${title} — error: ${e.message}`); }
}

await show("dealers (by owner_email OR company_name='Test')",
  `SELECT id, dealer_id, company_name, owner_email, finance_enabled, onboarding_status
   FROM dealers WHERE lower(owner_email)=lower($1) OR company_name ILIKE 'Test' ORDER BY id`, [EMAIL]);

await show("dealer_onboarding_applications (by company_name='Test')",
  `SELECT id, company_name, finance_enabled, onboarding_status, review_status, dealer_user_id
   FROM dealer_onboarding_applications WHERE company_name ILIKE 'Test' ORDER BY created_at DESC`, []);

await show("users (by email)",
  `SELECT id, email, role FROM users WHERE lower(email)=lower($1)`, [EMAIL]);

await c.end();
