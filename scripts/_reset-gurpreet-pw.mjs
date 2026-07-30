import fs from "node:fs";
import pg from "pg";
import bcrypt from "bcryptjs";
import { createClient } from "@supabase/supabase-js";

const EMAIL = "gurpreetsidana1979@gmail.com";
const PASSWORD = "password";

const envText = fs.readFileSync(".env.local", "utf8");
const envMap = Object.fromEntries(
  envText
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    }),
);

const db2Url = envText
  .split(/\r?\n/)
  .find((l) => l.startsWith("# DATABASE_URL=") && l.includes("database-2"))
  .replace(/^#\s*DATABASE_URL=/, "")
  .trim()
  .replace(/[?&]sslmode=require/, "");

const c = new pg.Client({ connectionString: db2Url, ssl: { rejectUnauthorized: false } });
await c.connect();

const found = await c.query(
  `select id, email, role, is_active from users where lower(email) = $1`,
  [EMAIL.toLowerCase()],
);
if (found.rows.length !== 1) throw new Error(`expected 1 user row, got ${found.rows.length}`);
const user = found.rows[0];
if (user.role !== "dealer") throw new Error(`role is ${user.role}, not dealer`);
if (!user.is_active) throw new Error("user is inactive");

// 1. Supabase Auth (what the login form actually authenticates against)
const admin = createClient(
  envMap.NEXT_PUBLIC_SUPABASE_URL,
  envMap.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } },
);
const { error: updErr } = await admin.auth.admin.updateUserById(user.id, {
  password: PASSWORD,
  email_confirm: true,
});
if (updErr) throw updErr;
console.log("supabase auth password updated for", user.id);

// 2. Mirror hash in users table
const hash = await bcrypt.hash(PASSWORD, 10);
const upd = await c.query(
  `update users set password_hash = $1, must_change_password = false, updated_at = now()
   where id = $2`,
  [hash, user.id],
);
console.log("users row updated:", upd.rowCount);
await c.end();

// 3. Verify by actually signing in
const anon = createClient(envMap.NEXT_PUBLIC_SUPABASE_URL, envMap.NEXT_PUBLIC_SUPABASE_ANON_KEY);
const signin = await anon.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
console.log(
  "verify signInWithPassword:",
  signin.error ? `FAILED — ${signin.error.message}` : `OK (${signin.data.user?.id})`,
);
