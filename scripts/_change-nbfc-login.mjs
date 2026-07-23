// Change an NBFC login email + reset its password across the two stores that
// authenticate a portal login: Supabase Auth (email + password) and
// public.users.email (row keyed by the Auth uid). Dry-run by default; pass
// --confirm to actually write.
//
//   node scripts/_change-nbfc-login.mjs <currentEmail> <targetEmail> [--confirm]
import { readFileSync } from "node:fs";
import crypto from "node:crypto";
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";

const CURRENT = process.argv[2];
const TARGET = process.argv[3];
const CONFIRM = process.argv.includes("--confirm");
if (!CURRENT || !TARGET) {
  console.error("usage: node scripts/_change-nbfc-login.mjs <currentEmail> <targetEmail> [--confirm]");
  process.exit(1);
}

function loadEnv() {
  for (const f of [".env.local", ".env"]) {
    try {
      for (const line of readFileSync(f, "utf8").split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    } catch {}
  }
}
loadEnv();

const DB_URL = process.env.DATABASE_URL;
const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
console.log("DB host       :", (DB_URL?.match(/@([^:/]+)/) || [])[1]);
console.log("SUPABASE URL  :", SB_URL);
console.log("current -> new:", CURRENT, "->", TARGET);
console.log("mode          :", CONFIRM ? "CONFIRM (will write)" : "DRY-RUN");
console.log("");

function genPassword() {
  const U = "ABCDEFGHJKLMNPQRSTUVWXYZ", L = "abcdefghijkmnpqrstuvwxyz", D = "23456789", S = "!@#$%*?";
  const ALL = U + L + D + S;
  const pick = (s) => s[crypto.randomInt(s.length)];
  const base = [pick(U), pick(L), pick(D), pick(S)];
  for (let i = 0; i < 12; i++) base.push(pick(ALL));
  // Fisher–Yates shuffle
  for (let i = base.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [base[i], base[j]] = [base[j], base[i]];
  }
  return base.join("");
}

const supa = createClient(SB_URL, SB_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const sql = postgres(DB_URL, { ssl: "require", prepare: false, max: 1, connect_timeout: 15 });

async function findAuthUser(email) {
  const t = email.toLowerCase();
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await supa.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error("listUsers: " + error.message);
    const f = (data?.users || []).find((u) => (u.email || "").toLowerCase() === t);
    if (f) return f;
    if (!data?.users?.length || data.users.length < 200) break;
  }
  return null;
}

try {
  // --- Safety checks ---
  const auth = await findAuthUser(CURRENT);
  if (!auth) throw new Error(`No Supabase Auth user for ${CURRENT}`);
  const uid = auth.id;
  console.log("auth uid      :", uid);

  const targetAuth = await findAuthUser(TARGET);
  if (targetAuth) throw new Error(`Target email already exists in Auth (uid=${targetAuth.id}) — aborting`);

  const targetRows = await sql`SELECT id FROM users WHERE lower(email) = lower(${TARGET})`;
  if (targetRows.length) throw new Error(`Target email already exists in public.users — aborting`);

  const userRow = (await sql`SELECT id, email, role FROM users WHERE id = ${uid}`)[0];
  if (!userRow) throw new Error(`No public.users row for uid ${uid}`);
  if (userRow.role !== "nbfc_partner") {
    console.warn(`WARN: users.role is '${userRow.role}', expected 'nbfc_partner' — continuing`);
  }

  const newPassword = genPassword();

  if (!CONFIRM) {
    console.log("\nDRY-RUN — would perform:");
    console.log(`  1. Supabase Auth updateUserById(${uid}, { email: '${TARGET}', email_confirm: true, password: <generated> })`);
    console.log(`  2. UPDATE users SET email='${TARGET}', updated_at=now() WHERE id='${uid}'`);
    console.log("\nRe-run with --confirm to apply.");
    process.exit(0);
  }

  // --- 1. Supabase Auth: email + password (the actual credential) ---
  const { error: authErr } = await supa.auth.admin.updateUserById(uid, {
    email: TARGET,
    email_confirm: true,
    password: newPassword,
  });
  if (authErr) throw new Error("Auth update failed: " + authErr.message);
  console.log("✓ Supabase Auth updated (email + password)");

  // --- 2. public.users email (keyed by the same uid) ---
  const upd = await sql`UPDATE users SET email = ${TARGET}, updated_at = now() WHERE id = ${uid} RETURNING id, email, role`;
  console.log("✓ public.users updated:", upd[0]);

  // --- Verify ---
  const verify = await findAuthUser(TARGET);
  console.log("\nVERIFY Auth email:", verify?.email, "| uid:", verify?.id);

  console.log("\n========================================");
  console.log(" NEW LOGIN CREDENTIALS (BatteryPool NBFC)");
  console.log("   Email    :", TARGET);
  console.log("   Password :", newPassword);
  console.log("========================================");
} catch (err) {
  console.error("\nERROR:", err.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
