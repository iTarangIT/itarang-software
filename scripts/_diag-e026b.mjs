import { readFileSync } from "node:fs";
import postgres from "postgres";
const env = readFileSync(".env.local","utf8");
const url = env.match(/^DATABASE_URL=(.*)$/m)[1].trim().replace(/^["']|["']$/g,"");
const sql = postgres(url,{ssl:"require",prepare:false,max:1,connect_timeout:15});
const T = async t => (await sql`SELECT to_regclass(${"public."+t}) AS r`)[0].r!=null;
const C = async (t,c) => (await sql`SELECT 1 FROM information_schema.columns WHERE table_name=${t} AND column_name=${c} LIMIT 1`).length>0;
try{
  console.log("nbfc table exists:", await T("nbfc"));
  console.log("nbfc_tenants table exists:", await T("nbfc_tenants"));
  console.log("nbfc.tenant_id column exists:", (await T("nbfc")) ? await C("nbfc","tenant_id") : "n/a");
  console.log("nbfc_users table exists:", await T("nbfc_users"));
} finally { await sql.end(); }
