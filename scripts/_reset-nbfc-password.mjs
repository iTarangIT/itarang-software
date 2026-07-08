// Reset a Supabase Auth user's password by email. Also clears must_change_password
// on the public.users row so the new password isn't immediately force-reset.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
function loadEnv(p){ if(!existsSync(p))return; for(const l of readFileSync(p,"utf8").split(/\r?\n/)){const t=l.trim();if(!t||t.startsWith("#"))continue;const i=t.indexOf("=");if(i<0)continue;const k=t.slice(0,i).trim();let v=t.slice(i+1).trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);if(!(k in process.env))process.env[k]=v;}}
loadEnv(join(ROOT,".env.local"));
loadEnv(join(ROOT,".env"));

const EMAIL = process.argv[2] || "chirag.itarang@gmail.com";
const NEWPW = process.argv[3] || "password";

const supa = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Find the auth user by email (paginate).
let found = null;
for (let page = 1; page <= 20 && !found; page++) {
  const { data, error } = await supa.auth.admin.listUsers({ page, perPage: 200 });
  if (error) { console.error("listUsers error:", error.message); process.exit(1); }
  found = (data?.users || []).find(u => (u.email||"").toLowerCase() === EMAIL.toLowerCase());
  if (!data?.users?.length) break;
}
if (!found) { console.error(`No Supabase auth user for ${EMAIL}`); process.exit(1); }

const { error: upErr } = await supa.auth.admin.updateUserById(found.id, { password: NEWPW });
if (upErr) { console.error("updateUser error:", upErr.message); process.exit(1); }
console.log(`Supabase password updated for ${EMAIL} (id ${found.id})`);

// Clear must_change_password so login doesn't immediately force a reset.
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const r = await c.query(`UPDATE users SET must_change_password=false, updated_at=now() WHERE id=$1 RETURNING email, must_change_password`, [found.id]);
console.log("users row:", JSON.stringify(r.rows[0] || null));
await c.end();
console.log(`\nDONE — login: ${EMAIL} / password: ${NEWPW}`);
