// Inspect the BAT-3W-TEST inventory and the dealer linkage vs kartik's dealer.
// READ-ONLY.
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

// 1. kartik's dealer record.
const dealer = (await c.query(
  `SELECT id, dealer_id AS dealer_code, company_name, owner_name, owner_email FROM dealers WHERE lower(owner_email)=lower($1)`,
  ["kartik.itarang@gmail.com"])).rows;
console.log("\n=== kartik dealer(s) ===");
for (const d of dealer) console.log(JSON.stringify(d));

// 2. The BAT-3W-TEST inventory rows: how many, distinct dealer_id values.
const grp = (await c.query(
  `SELECT dealer_id, status, COUNT(*)::int AS n
   FROM inventory WHERE serial_number ILIKE 'BAT-3W-TEST-%'
   GROUP BY dealer_id, status ORDER BY dealer_id, status`)).rows;
console.log("\n=== BAT-3W-TEST-* grouped by (dealer_id, status) ===");
for (const r of grp) console.log(JSON.stringify(r));

// 3. Sample rows.
const sample = (await c.query(
  `SELECT id, serial_number, dealer_id, status, warehouse_location, final_amount
   FROM inventory WHERE serial_number ILIKE 'BAT-3W-TEST-%' ORDER BY serial_number LIMIT 12`)).rows;
console.log("\n=== sample BAT-3W-TEST rows ===");
for (const r of sample) console.log(JSON.stringify(r));

// 4. Resolve any dealer_id values found back to a dealer name.
const dids = [...new Set(grp.map(g=>g.dealer_id).filter(Boolean))];
if (dids.length) {
  const res = (await c.query(
    `SELECT id, dealer_id AS dealer_code, company_name, owner_email FROM dealers
     WHERE dealer_id = ANY($1) OR id::text = ANY($1)`, [dids])).rows;
  console.log("\n=== dealers referenced by those inventory.dealer_id values ===");
  console.log("inventory.dealer_id distinct:", JSON.stringify(dids));
  for (const r of res) console.log(JSON.stringify(r));
}
await c.end();
