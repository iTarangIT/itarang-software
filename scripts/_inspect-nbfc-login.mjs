// READ-ONLY: inspect an NBFC login across Supabase Auth + public.users + the
// nbfc_users -> nbfc_tenants -> nbfc linkage, and check whether a target email
// is already taken. No writes.
//   node scripts/_inspect-nbfc-login.mjs <currentEmail> [<targetEmail>]
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";

const CURRENT = process.argv[2];
const TARGET = process.argv[3] || "";
if (!CURRENT) {
  console.error("usage: node scripts/_inspect-nbfc-login.mjs <currentEmail> [<targetEmail>]");
  process.exit(1);
}

function loadEnv() {
  for (const f of [".env.local", ".env"]) {
    try {
      const txt = readFileSync(f, "utf8");
      for (const line of txt.split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && !(m[1] in process.env)) {
          process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
        }
      }
    } catch {}
  }
}
loadEnv();

const DB_URL = process.env.DATABASE_URL;
const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const dbHost = (DB_URL?.match(/@([^:/]+)/) || [])[1];
console.log("=== ENVIRONMENT (confirm this is the intended target) ===");
console.log("  DATABASE_URL host :", dbHost);
console.log("  SUPABASE URL      :", SB_URL);
console.log("  current email     :", CURRENT);
console.log("  target email      :", TARGET || "(none — inspection only)");
console.log("");

const sql = postgres(DB_URL, { ssl: "require", prepare: false, max: 1, connect_timeout: 15 });
const supa = createClient(SB_URL, SB_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

async function findAuthUser(email) {
  const target = email.toLowerCase();
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await supa.auth.admin.listUsers({ page, perPage: 200 });
    if (error) { console.error("listUsers error:", error.message); return null; }
    const found = (data?.users || []).find((u) => (u.email || "").toLowerCase() === target);
    if (found) return found;
    if (!data?.users?.length || data.users.length < 200) break;
  }
  return null;
}

try {
  // --- Supabase Auth ---
  const auth = await findAuthUser(CURRENT);
  console.log("=== SUPABASE AUTH (current email) ===");
  if (auth) {
    console.log("  uid          :", auth.id);
    console.log("  email        :", auth.email);
    console.log("  role meta    :", auth.user_metadata?.role);
    console.log("  confirmed_at :", auth.email_confirmed_at || auth.confirmed_at);
    console.log("  last_sign_in :", auth.last_sign_in_at);
  } else {
    console.log("  NOT FOUND in Supabase Auth for", CURRENT);
  }
  console.log("");

  if (TARGET) {
    const authTarget = await findAuthUser(TARGET);
    console.log("=== SUPABASE AUTH (target email) — must be free ===");
    console.log(authTarget ? `  ALREADY EXISTS: uid=${authTarget.id}` : "  free (no auth user)");
    console.log("");
  }

  // --- public.users (by auth uid, then by email) ---
  console.log("=== public.users ===");
  let userRow = null;
  if (auth) {
    const byId = await sql`SELECT id, email, name, role, must_change_password FROM users WHERE id = ${auth.id}`;
    if (byId.length) { userRow = byId[0]; console.log("  matched by id (auth uid):", byId[0]); }
  }
  const byEmail = await sql`SELECT id, email, name, role, must_change_password FROM users WHERE lower(email) = lower(${CURRENT})`;
  console.log(`  rows matching email (case-insensitive): ${byEmail.length}`);
  for (const r of byEmail) console.log("   ", r);
  if (!userRow && byEmail.length) userRow = byEmail[0];

  if (TARGET) {
    const targetRows = await sql`SELECT id, email, role FROM users WHERE lower(email) = lower(${TARGET})`;
    console.log(`  rows matching TARGET email: ${targetRows.length}`, targetRows);
  }
  console.log("");

  // --- NBFC linkage: nbfc_users -> nbfc_tenants -> nbfc ---
  console.log("=== NBFC LINKAGE (confirm BatteryPool) ===");
  const linkId = userRow?.id || auth?.id;
  if (linkId) {
    const links = await sql`
      SELECT nu.user_id, nu.tenant_id, nu.role AS membership_role,
             t.slug, t.display_name, t.contact_email,
             n.id AS nbfc_pk, n.nbfc_id, n.legal_name, n.short_name,
             n.primary_contact_email, n.status
      FROM nbfc_users nu
      LEFT JOIN nbfc_tenants t ON t.id = nu.tenant_id
      LEFT JOIN nbfc n ON n.tenant_id = t.id
      WHERE nu.user_id = ${linkId}`;
    console.log(`  memberships: ${links.length}`);
    for (const l of links) console.log("   ", l);
  } else {
    console.log("  no user id to trace linkage");
  }
  console.log("");

  // --- Any NBFC named BatteryPool (independent of the user) ---
  console.log("=== NBFC rows matching 'batterypool' (by name) ===");
  const nbfcs = await sql`
    SELECT id, nbfc_id, legal_name, short_name, primary_contact_email, status, tenant_id
    FROM nbfc
    WHERE lower(legal_name) LIKE '%batterypool%' OR lower(short_name) LIKE '%batterypool%'
       OR lower(legal_name) LIKE '%battery pool%' OR lower(short_name) LIKE '%battery pool%'`;
  console.log(`  matches: ${nbfcs.length}`);
  for (const n of nbfcs) console.log("   ", n);
} finally {
  await sql.end();
}
