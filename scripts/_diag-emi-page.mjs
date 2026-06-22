// Diagnose why /nbfc/emi-tracker shows 0 loans after seeding. Replicates the
// page's exact list query + checks each sample table independently. READ-ONLY.
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
const db = (await c.query(`SELECT current_database() d`)).rows[0].d;
console.log(`Host: ${host}\nDatabase: ${db}\n`);

const T = (await c.query(`SELECT id, display_name, active_loans FROM nbfc_tenants WHERE display_name ILIKE '%itarang%finance%' OR slug ILIKE '%itarang%' ORDER BY active_loans DESC NULLS LAST LIMIT 1`)).rows[0];
console.log(`Tenant: ${T.display_name} (${T.id}) cached active_loans=${T.active_loans}\n`);

const q = async (label, sql, params=[]) => {
  const r = await c.query(sql, params);
  console.log(`${label}: ${r.rows[0] ? JSON.stringify(r.rows[0]) : r.rows.length + " rows"}`);
};

await q("sample leads",            `SELECT count(*)::int n FROM leads WHERE id LIKE 'EMI-SAMPLE-%'`);
await q("sample loan_sanctions",   `SELECT count(*)::int n FROM loan_sanctions WHERE id LIKE 'EMI-SAMPLE-%'`);
await q("sample loan_sanctions for tenant", `SELECT count(*)::int n FROM loan_sanctions WHERE id LIKE 'EMI-SAMPLE-%' AND nbfc_id=$1`, [T.id]);
await q("sample nbfc_loans active", `SELECT count(*)::int n FROM nbfc_loans WHERE loan_application_id LIKE 'EMI-SAMPLE-%' AND is_active=true`);
await q("sample emi_schedules",    `SELECT count(*)::int n FROM emi_schedules WHERE loan_sanction_id LIKE 'EMI-SAMPLE-%'`);

console.log("\n-- the page's exact INNER JOIN (table query core) --");
await q("nbfc_loans JOIN loan_sanctions for tenant, is_active", `
  SELECT count(*)::int n
  FROM nbfc_loans nl
  JOIN loan_sanctions ls ON ls.id = nl.loan_application_id
  WHERE nl.tenant_id = $1 AND nl.is_active = true`, [T.id]);

await q("all active nbfc_loans for tenant (no join)", `SELECT count(*)::int n FROM nbfc_loans WHERE tenant_id=$1 AND is_active=true`, [T.id]);

console.log("\n-- type check: is nbfc_loans.tenant_id actually = this tenant? sample 3 --");
const s = await c.query(`SELECT nl.loan_application_id, nl.tenant_id, nl.is_active,
   (SELECT count(*)::int FROM loan_sanctions ls WHERE ls.id = nl.loan_application_id) AS has_sanction
   FROM nbfc_loans nl WHERE nl.loan_application_id LIKE 'EMI-SAMPLE-%' LIMIT 3`);
console.table(s.rows);

console.log("\n-- orphan check: active nbfc_loans for tenant WITHOUT a loan_sanction --");
await q("orphans", `
  SELECT count(*)::int n FROM nbfc_loans nl
  WHERE nl.tenant_id=$1 AND nl.is_active=true
    AND NOT EXISTS (SELECT 1 FROM loan_sanctions ls WHERE ls.id = nl.loan_application_id)`, [T.id]);

await c.end();
