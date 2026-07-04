// Rollback snapshot for the E-170 URL backfill. Exports current values of the
// affected columns (rows containing a Supabase public URL) to
// scripts/out/url-backfill-snapshot.json. READ-ONLY.
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
function load(p){ if(!existsSync(p))return; for(const l of readFileSync(p,"utf8").split(/\r?\n/)){const t=l.trim();if(!t||t.startsWith("#"))continue;const i=t.indexOf("=");if(i<0)continue;const k=t.slice(0,i).trim();let v=t.slice(i+1).trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);if(!(k in process.env))process.env[k]=v;}}
load(join(ROOT,".env.local"));
const TARGETS=[
  ["ai_call_logs","recording_url"],["consent_records","generated_pdf_url"],["consent_records","signed_consent_url"],
  ["dealer_onboarding_applications","signed_agreement_url"],["dealer_onboarding_applications","audit_trail_url"],
  ["dealer_onboarding_documents","file_url"],["kyc_documents","file_url"],["other_document_requests","file_url"],
  ["product_selections","battery_photo_urls"],["product_selections","charger_photo_urls"],
];
const c=new pg.Client({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});
await c.connect();
const snapshot={};
let rows=0;
for(const [t,col] of TARGETS){
  try{
    const r=(await c.query(`SELECT id, ${col}::text AS v FROM "${t}" WHERE ${col}::text LIKE '%/storage/v1/object/public/%'`)).rows;
    snapshot[`${t}.${col}`]=r;
    rows+=r.length;
    console.log(`  ${t}.${col}: ${r.length} rows`);
  }catch(e){ console.log(`  ${t}.${col}: ERR ${e.message}`); }
}
await c.end();
const outDir=join(ROOT,"scripts","out"); if(!existsSync(outDir)) mkdirSync(outDir,{recursive:true});
const out=join(outDir,"url-backfill-snapshot.json");
writeFileSync(out,JSON.stringify(snapshot,null,2));
console.log(`\nSnapshot of ${rows} rows written to ${out}`);
