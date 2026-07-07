// Diagnostic: what relation actually backs "daily km" on the intellicar VPS DB?
// The code queries daily_distance_per_vehicle, but pgAdmin shows distance_rollup
// / dashboard_vehicle_monthly_range and no daily_distance_per_vehicle table.
// Read-only.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
function loadEnv(p){ if(!existsSync(p))return; for(const l of readFileSync(p,"utf8").split(/\r?\n/)){const t=l.trim();if(!t||t.startsWith("#"))continue;const i=t.indexOf("=");if(i<0)continue;const k=t.slice(0,i).trim();let v=t.slice(i+1).trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);if(!(k in process.env))process.env[k]=v;}}
loadEnv(join(ROOT,".env.local"));
loadEnv(join(ROOT,".env"));

const sslmode = (()=>{ try { return new URL(process.env.IOT_DATABASE_URL).searchParams.get("sslmode"); } catch { return null; } })();
const c = new pg.Client({ connectionString: process.env.IOT_DATABASE_URL, ssl: sslmode==="disable" ? false : { rejectUnauthorized: false } });
await c.connect();
const host = (process.env.IOT_DATABASE_URL||"").replace(/.*@/,"").split(/[:/]/)[0];
const dbname = (await c.query(`SELECT current_database() AS db`)).rows[0].db;
console.log(`VPS host: ${host}   database: ${dbname}\n`);

// 1. Every relation whose name mentions distance/rollup/km/daily — with kind.
const kind = { r:"table", v:"view", m:"matview", p:"partitioned", f:"foreign" };
const rels = (await c.query(`
  SELECT n.nspname AS schema, c.relname AS name, c.relkind
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r','v','m','p','f')
    AND (c.relname ILIKE '%distance%' OR c.relname ILIKE '%rollup%'
         OR c.relname ILIKE '%daily%' OR c.relname ILIKE '%range%' OR c.relname ILIKE '%km%')
  ORDER BY c.relname
`)).rows;
console.log("Relations matching distance/rollup/daily/range/km:");
for (const r of rels) console.log(`  ${r.schema}.${r.name}  [${kind[r.relkind] ?? r.relkind}]`);

// 2. Does daily_distance_per_vehicle exist at all?
const dd = rels.find(r => r.name === "daily_distance_per_vehicle");
console.log(`\ndaily_distance_per_vehicle exists? ${dd ? `YES (${kind[dd.relkind]})` : "NO — the code queries a relation that is not here"}`);

// 3. Inspect the real distance relations: columns + row count + sample.
async function inspect(name){
  try {
    const cols = (await c.query(`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name=$1 ORDER BY ordinal_position`, [name])).rows;
    if (cols.length === 0) { console.log(`\n[${name}] not found`); return; }
    const cnt = (await c.query(`SELECT COUNT(*)::int AS n FROM ${name}`)).rows[0].n;
    console.log(`\n[${name}]  rows=${cnt}`);
    console.log(`  columns: ${cols.map(x=>`${x.column_name}:${x.data_type}`).join(", ")}`);
    if (cnt > 0) {
      const sample = (await c.query(`SELECT * FROM ${name} LIMIT 2`)).rows;
      console.log(`  sample:  ${JSON.stringify(sample)}`);
    }
  } catch(e){ console.log(`\n[${name}] error: ${e.message}`); }
}
for (const n of ["daily_distance_per_vehicle","distance_rollup","dashboard_vehicle_monthly_range"]) await inspect(n);

await c.end();
