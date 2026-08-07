/**
 * Seeds the Ops Console monitoring login.
 *
 *   email:    operations@itarang.com
 *   password: password           (override with OPS_USER_PASSWORD)
 *   role:     operations
 *
 * Writes to BOTH, because the two are read by different layers and a login
 * that exists in only one fails in a confusing way:
 *   - Supabase Auth        → app_metadata.role is what src/middleware.ts reads
 *                            to resolve the role and pick the landing page.
 *   - public.users on RDS  → what requireAuth()/requireOperationsAdmin() read.
 *                            A missing row degrades to a synthetic {role:"user"}
 *                            object and the console 403s with no clue why.
 *
 * Keyed on the Supabase auth UUID, never on email — Supabase lowercases emails
 * while users.email is mixed-case across historical rows.
 *
 * Idempotent: re-running resets the password, refreshes app_metadata, and
 * updates the RDS row.
 *
 * Usage:  npm run seed:operations-user
 * Run it once against database-1 (sandbox) and once against database-2 (prod)
 * — point .env.local's DATABASE_URL at each in turn.
 *
 * Requires: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL.
 *
 * The default password is fine for sandbox. ROTATE IT ON PROD once the console
 * is live — this login can read company spend and infrastructure detail.
 */

import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";

const USER = {
  email: process.env.OPS_USER_EMAIL || "operations@itarang.com",
  password: process.env.OPS_USER_PASSWORD || "password",
  name: "Tech Ops",
  role: "operations",
};

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const databaseUrl = process.env.DATABASE_URL;

if (!supabaseUrl || !serviceRoleKey) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set");
  process.exit(1);
}
if (!databaseUrl) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const sql = postgres(databaseUrl, {
  ssl: { rejectUnauthorized: false },
  max: 1,
});

/**
 * GoTrue admin has no by-email getter in supabase-js 2.x, so page listUsers().
 * Paging matters: the unpaginated form silently truncates at the default page
 * size, and on a tenant with more accounts than that this script would create a
 * duplicate auth user instead of updating the existing one.
 */
async function findAuthUserByEmail(email: string) {
  const target = email.toLowerCase();
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listUsers page ${page} failed: ${error.message}`);

    const hit = data.users.find((u) => (u.email || "").toLowerCase() === target);
    if (hit) return hit;
    if (data.users.length < 200) return null;
  }
  return null;
}

async function run() {
  const dbHost = new URL(databaseUrl!).hostname;
  console.log(`Seeding ${USER.role} user: ${USER.email}`);
  console.log(`  target DB: ${dbHost}`);

  // 1. Supabase Auth — create or update, and set app_metadata.role.
  const existing = await findAuthUserByEmail(USER.email);
  let authId: string;

  if (existing) {
    authId = existing.id;
    const { error } = await supabase.auth.admin.updateUserById(authId, {
      password: USER.password,
      app_metadata: { ...(existing.app_metadata || {}), role: USER.role },
    });
    if (error) throw new Error(`Failed to update auth user: ${error.message}`);
    console.log(`  auth user existed — password + app_metadata.role refreshed (id: ${authId})`);
  } else {
    const { data, error } = await supabase.auth.admin.createUser({
      email: USER.email,
      password: USER.password,
      email_confirm: true,
      app_metadata: { role: USER.role },
    });
    if (error) throw new Error(`Failed to create auth user: ${error.message}`);
    authId = data.user.id;
    console.log(`  auth user created (id: ${authId})`);
  }

  // 2. RDS users row. password_hash is left NULL deliberately — authentication
  //    is Supabase's; the column is only a mirror for the flows that write it
  //    (dealer/vendor onboarding, /api/auth/change-password) and an unused
  //    credential hash on a shared login is a liability, not a safety net.
  await sql`
    INSERT INTO users (id, email, name, role, is_active, must_change_password, created_at, updated_at)
    VALUES (${authId}::uuid, ${USER.email}, ${USER.name}, ${USER.role}, true, false, NOW(), NOW())
    ON CONFLICT (id) DO UPDATE SET
      email = EXCLUDED.email,
      name = EXCLUDED.name,
      role = EXCLUDED.role,
      is_active = true,
      must_change_password = false,
      updated_at = NOW()
  `;

  // Reconcile a legacy row carrying the same email under a different id — a
  // leftover of an auth user deleted from Supabase but never from RDS.
  // requireAuth() falls back to an email lookup, so a stale row with the wrong
  // role would win on that path.
  await sql`
    UPDATE users
    SET role = ${USER.role}, is_active = true, must_change_password = false, updated_at = NOW()
    WHERE email = ${USER.email} AND id <> ${authId}::uuid
  `;
  console.log("  RDS users row ready");

  // 3. Prove the login actually works end to end.
  const { error: loginErr } = await supabase.auth.signInWithPassword({
    email: USER.email,
    password: USER.password,
  });
  if (loginErr) throw new Error(`Login test failed: ${loginErr.message}`);
  console.log("  login verified");

  console.log("\n──────────────────────────────────────────");
  console.log(`  ${USER.email}  /  ${USER.password}  →  /operations`);
  console.log("──────────────────────────────────────────\n");

  await sql.end();
  process.exit(0);
}

run().catch(async (err) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  try {
    await sql.end();
  } catch {
    /* already closed */
  }
  process.exit(1);
});
