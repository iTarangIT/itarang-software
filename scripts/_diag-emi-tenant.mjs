// Resolve which tenant the logged-in NBFC partner actually maps to (the way
// getCurrentTenant does: their nbfc_users membership) and count loans per
// candidate tenant. Pinpoints the "page shows 0 but data exists" mismatch.
// READ-ONLY.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
function loadEnv(p){ if(!existsSync(p))return; for(const l of readFileSync(p,"utf8").split(/\r?\n/)){const t=l.trim();if(!t||t.startsWith("#"))continue;const i=t.indexOf("=");if(i<0)continue;const k=t.slice(0,i).trim();let v=t.slice(i+1).trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);if(!(k in process.env))process.env[k]=v;}}
loadEnv(join(ROOT,".env.local"));

const EMAIL = "2thta4089@allfreemail.net";  // logged-in NBFC partner (from middleware logs)

const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();

console.log("== user row(s) for", EMAIL, "==");
const users = (await c.query(`SELECT id, email, role FROM users WHERE lower(email)=lower($1)`, [EMAIL])).rows;
console.table(users);

console.log("\n== ALL tenants named like 'iTarang Finance' ==");
const tenants = (await c.query(`SELECT id, slug, display_name, active_loans, is_active FROM nbfc_tenants WHERE display_name ILIKE '%itarang%' OR slug ILIKE '%itarang%' ORDER BY display_name`)).rows;
console.table(tenants);

console.log("\n== nbfc_users memberships for this user (what getCurrentTenant reads) ==");
for (const u of users) {
  const m = (await c.query(`
    SELECT nu.tenant_id, t.display_name, t.is_active, t.active_loans
    FROM nbfc_users nu JOIN nbfc_tenants t ON t.id = nu.tenant_id
    WHERE nu.user_id = $1`, [u.id])).rows;
  console.log(`user ${u.id}:`);
  console.table(m);
}

console.log("\n== page list-query count per iTarang tenant ==");
for (const t of tenants) {
  const n = (await c.query(`
    SELECT count(*)::int n FROM nbfc_loans nl
    JOIN loan_sanctions ls ON ls.id = nl.loan_application_id
    WHERE nl.tenant_id = $1 AND nl.is_active = true`, [t.id])).rows[0].n;
  console.log(`  ${t.display_name} (${t.id}) -> ${n} loans`);
}

await c.end();
