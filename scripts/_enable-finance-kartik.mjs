// Set finance_enabled=true for the active dealer login kartik.itarang@gmail.com
// (dealers.id=2). Scoped by id AND email so it can only touch that one row.
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

const before = (await c.query(
  `SELECT id, company_name, owner_email, finance_enabled FROM dealers WHERE id=2 AND lower(owner_email)=lower($1)`,
  ["kartik.itarang@gmail.com"])).rows[0];
if (!before) { console.log("Target row not found (id=2 + email). Aborting, no change made."); await c.end(); process.exit(1); }
console.log("BEFORE:", JSON.stringify(before));

const upd = await c.query(
  `UPDATE dealers SET finance_enabled=true, updated_at=now()
   WHERE id=2 AND lower(owner_email)=lower($1) AND finance_enabled=false
   RETURNING id, company_name, owner_email, finance_enabled, updated_at`,
  ["kartik.itarang@gmail.com"]);
console.log(`Rows updated: ${upd.rowCount}`);
if (upd.rowCount) console.log("AFTER: ", JSON.stringify(upd.rows[0]));
else console.log("No update applied (already true or guard mismatch).");

// Show any NBFC assignments — finance_enabled alone shows the finance option,
// but the dealer needs a dealer_nbfc_assignments row to have an NBFC to pick.
const asg = await c.query(
  `SELECT id, nbfc_id, status FROM dealer_nbfc_assignments WHERE dealer_id=2 ORDER BY id`);
console.log(`\ndealer_nbfc_assignments for dealer_id=2: ${asg.rowCount}`);
for (const r of asg.rows) console.log("  ", JSON.stringify(r));

await c.end();
