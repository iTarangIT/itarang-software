// READ-ONLY: find the portal login id (email) for an NBFC by legal/short name.
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
const NAME = process.argv[2] || "Finance 1";

async function show(title, q, params){
  try { const r = await c.query(q, params); console.log(`\n=== ${title} (${r.rowCount}) ===`); for(const row of r.rows) console.log(JSON.stringify(row)); }
  catch(e){ console.log(`\n=== ${title} — error: ${e.message}`); }
}

await show("nbfc (by name)",
  `SELECT id, nbfc_id, legal_name, short_name, status, primary_contact_email, primary_contact_name, lsp_agreement_id, activated_at
   FROM nbfc WHERE legal_name ILIKE '%'||$1||'%' OR short_name ILIKE '%'||$1||'%' ORDER BY id`, [NAME]);

// NBFC-side LSP signer email = the actual portal login id
await show("nbfc-side LSP signers (login id source)",
  `SELECT s.nbfc_lsp_agreement_id, a.nbfc_id, s.party, s.signer_order, s.email, s.full_name, a.agreement_status
   FROM nbfc_lsp_agreement_signers s
   JOIN nbfc_lsp_agreements a ON a.id = s.nbfc_lsp_agreement_id
   JOIN nbfc n ON n.id = a.nbfc_id
   WHERE (n.legal_name ILIKE '%'||$1||'%' OR n.short_name ILIKE '%'||$1||'%') AND s.party='nbfc'
   ORDER BY a.nbfc_id, s.signer_order`, [NAME]);

await show("nbfc_portal_credentials + user email",
  `SELECT pc.nbfc_id, pc.dispatch_status, pc.email_dispatched_at, pc.supabase_user_id, u.email AS login_email, u.role, u.must_change_password
   FROM nbfc_portal_credentials pc
   JOIN nbfc n ON n.id = pc.nbfc_id
   LEFT JOIN users u ON u.id = pc.supabase_user_id
   WHERE n.legal_name ILIKE '%'||$1||'%' OR n.short_name ILIKE '%'||$1||'%'
   ORDER BY pc.created_at DESC`, [NAME]);

await c.end();
