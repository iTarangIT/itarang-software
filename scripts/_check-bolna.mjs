import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
const ROOT=join(dirname(fileURLToPath(import.meta.url)),"..");
function load(p){if(!existsSync(p))return;for(const l of readFileSync(p,"utf8").split(/\r?\n/)){const t=l.trim();if(!t||t.startsWith("#"))continue;const i=t.indexOf("=");if(i<0)continue;const k=t.slice(0,i).trim();let v=t.slice(i+1).trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);if(!(k in process.env))process.env[k]=v;}}
load(join(ROOT,".env.local"));
const c=new pg.Client({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});
await c.connect();
for(const [t,col] of [["ai_call_logs","recording_url"],["bolna_calls","recording_url"]]){
  try{
    const tot=(await c.query(`SELECT count(*)::int n, count(${col})::int withurl FROM "${t}"`)).rows[0];
    const sup=(await c.query(`SELECT count(*)::int n FROM "${t}" WHERE ${col} LIKE '%/storage/v1/object/public/call-recordings/%'`)).rows[0].n;
    const ext=(await c.query(`SELECT ${col} v FROM "${t}" WHERE ${col} IS NOT NULL AND ${col} NOT LIKE '%/storage/v1/object/public/%' LIMIT 2`)).rows.map(r=>r.v);
    console.log(`${t}.${col}: rows=${tot.n} withUrl=${tot.withurl} supabaseCallRec=${sup} sampleExternal=${JSON.stringify(ext)}`);
  }catch(e){console.log(`${t}.${col}: ERR ${e.message}`);}
}
await c.end();
