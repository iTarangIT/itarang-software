#!/usr/bin/env node
// Create (or reset) the test account onboarding@itarang.com / password.
//
//   node scripts/create-onboarding-user.mjs
//
// Mirrors scripts/seed-test-data.ts: creates the Supabase Auth user via the
// service-role admin API, then upserts the matching app `users` row (AWS RDS).
// Role is inside_sales_rep — the internal-staff persona that onboards dealers
// (BRD §0.13). Safe to re-run: existing user → password reset + row upsert.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";

const EMAIL = "onboarding@itarang.com";
const PASSWORD = "password";
const NAME = "Onboarding Staff";
// Dashboard-less role: login redirects it straight to /dealer-onboarding
// (the save-drafts workspace) — see src/app/(auth)/login/actions.ts.
const ROLE = "onboarding";

async function loadEnv() {
  const raw = await readFile(resolve(process.cwd(), ".env.local"), "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m || process.env[m[1]]) continue;
    process.env[m[1]] = m[2].replace(/^["'](.*)["']$/, "$1");
  }
}

await loadEnv();
const DATABASE_URL = process.env.DATABASE_URL;
const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!DATABASE_URL || !SUPA_URL || !SVC) {
  console.error(
    "Missing env. Need DATABASE_URL, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY in .env.local"
  );
  process.exit(1);
}

const supabase = createClient(SUPA_URL, SVC, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// 1) Supabase Auth user (create or reset password).
let userId;
const { data: list, error: listErr } = await supabase.auth.admin.listUsers();
if (listErr) {
  console.error("[auth] listUsers failed:", listErr.message);
  process.exit(1);
}
const existing = list?.users?.find((u) => u.email === EMAIL);
if (existing) {
  userId = existing.id;
  await supabase.auth.admin.updateUserById(userId, {
    password: PASSWORD,
    email_confirm: true,
  });
  console.log(`[auth] reset existing user ${EMAIL} (${userId})`);
} else {
  const { data, error } = await supabase.auth.admin.createUser({
    email: EMAIL,
    password: PASSWORD,
    email_confirm: true,
  });
  if (error) {
    console.error("[auth] create failed:", error.message);
    process.exit(1);
  }
  userId = data.user.id;
  console.log(`[auth] created user ${EMAIL} (${userId})`);
}

// 2) App users row (AWS RDS).
const sql = postgres(DATABASE_URL, { ssl: "require", prepare: false, max: 1 });
try {
  await sql`
    INSERT INTO users (id, email, name, role, is_active, must_change_password, created_at, updated_at)
    VALUES (${userId}, ${EMAIL}, ${NAME}, ${ROLE}, true, false, now(), now())
    ON CONFLICT (id) DO UPDATE
      SET email = EXCLUDED.email,
          name = EXCLUDED.name,
          role = EXCLUDED.role,
          is_active = true,
          must_change_password = false,
          updated_at = now()
  `;
  console.log(`[db] upserted users row: ${EMAIL} role=${ROLE}`);
} catch (e) {
  console.error("[db] upsert failed:", e.message);
  process.exit(1);
} finally {
  await sql.end({ timeout: 5 });
}

console.log(`\nDone. Login: ${EMAIL} / ${PASSWORD}  (role: ${ROLE})`);
