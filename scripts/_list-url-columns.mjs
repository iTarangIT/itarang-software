// Enumerate every (table, column) in database-2 that currently holds an absolute
// Supabase-storage public URL, grouped by target bucket. Drives the Part C
// backfill so it targets real columns. READ-ONLY.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
function load(p){ if(!existsSync(p))return; for(const l of readFileSync(p,"utf8").split(/\r?\n/)){const t=l.trim();if(!t||t.startsWith("#"))continue;const i=t.indexOf("=");if(i<0)continue;const k=t.slice(0,i).trim();let v=t.slice(i+1).trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);if(!(k in process.env))process.env[k]=v;}}
load(join(ROOT,".env.local"));
const c=new pg.Client({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});
await c.connect();
await c.query("SET statement_timeout='120s'");
const cols=(await c.query(`
  SELECT c.table_name, c.column_name, c.data_type
  FROM information_schema.columns c
  JOIN pg_class pc ON pc.relname=c.table_name
  JOIN pg_namespace pn ON pn.oid=pc.relnamespace AND pn.nspname='public'
  WHERE c.table_schema='public' AND pc.relkind='r'
    AND c.data_type IN ('text','character varying','character','json','jsonb')
  ORDER BY c.table_name,c.column_name`)).rows;
const hits=[];
for(const col of cols){
  const t=`"${col.table_name}"`, cc=`"${col.column_name}"`;
  try{
    const r=(await c.query(`SELECT count(*)::int n,
      count(*) FILTER (WHERE ${cc}::text ~ '/storage/v1/object/public/nbfc-documents/')::int nbfc,
      count(*) FILTER (WHERE ${cc}::text ~ '/storage/v1/object/public/(documents|dealer-documents|call-recordings)/')::int gen
      FROM ${t} WHERE ${cc}::text ~ '/storage/v1/object/public/'`)).rows[0];
    if(r.n>0) hits.push({col:`${col.table_name}.${col.column_name}`, type:col.data_type, total:r.n, nbfc:r.nbfc, gen:r.gen});
  }catch(e){ hits.push({col:`${col.table_name}.${col.column_name}`, type:col.data_type, error:e.message}); }
}
await c.end();
console.log(`Columns containing a Supabase public URL: ${hits.length}\n`);
for(const h of hits) console.log(h.error?`  ERR ${h.col}: ${h.error}`:`  ${h.col} [${h.type}] total=${h.total} nbfc=${h.nbfc} general=${h.gen}`);
