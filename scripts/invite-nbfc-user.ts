/**
 * Invite a new NBFC partner user.
 *
 * Usage:
 *   tsx scripts/invite-nbfc-user.ts \
 *     --email partner@somenbfc.com \
 *     --name "Jane Partner" \
 *     --tenant demo-nbfc \
 *     [--role admin|viewer]   # default: viewer
 *     [--password "Temp@1234"] # default: random; printed once
 *
 * What it does (idempotent — safe to re-run):
 *   1. Creates (or finds) the Supabase auth user with a temp password
 *   2. Sets users.role = 'nbfc_partner', must_change_password = true,
 *      and writes the same id/email into the CRM users table
 *   3. Inserts a row into nbfc_users linking the user to the tenant
 *
 * Requires .env.local with:
 *   - DATABASE_URL                     (CRM RDS)
 *   - NEXT_PUBLIC_SUPABASE_URL
 *   - SUPABASE_SERVICE_ROLE_KEY
 */
// Load .env.local first (Next.js convention), then fall back to .env so this
// script works in both local-dev and CI/Vercel environments.
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local" });
loadDotenv(); // .env (does NOT overwrite already-set vars)

import { db } from "@/lib/db";
import { nbfcTenants, nbfcUsers, users } from "@/lib/db/schema";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { eq, and } from "drizzle-orm";

interface Args {
  email: string;
  name: string;
  tenant: string;
  role: "admin" | "viewer";
  password?: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (k: string) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const email = get("email");
  const name = get("name");
  const tenant = get("tenant");
  const role = (get("role") ?? "viewer") as Args["role"];
  const password = get("password");
  if (!email || !name || !tenant) {
    console.error(
      "Usage: tsx scripts/invite-nbfc-user.ts --email <e> --name <n> --tenant <slug> [--role admin|viewer] [--password <p>]",
    );
    process.exit(1);
  }
  if (role !== "admin" && role !== "viewer") {
    console.error("--role must be 'admin' or 'viewer'");
    process.exit(1);
  }
  return { email, name, tenant, role, password };
}

function genPassword(): string {
  // 16 chars, alphanum + a few symbols. Avoid URL-special chars (@/+#).
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!_-.";
  let out = "";
  for (let i = 0; i < 16; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

async function main() {
  const args = parseArgs();
  const tempPassword = args.password ?? genPassword();

  console.log(`→ Inviting ${args.email} as ${args.role} of '${args.tenant}'`);

  // Step 1: tenant exists?
  const tenantRow = await db
    .select()
    .from(nbfcTenants)
    .where(eq(nbfcTenants.slug, args.tenant))
    .limit(1)
    .then((r) => r[0]);
  if (!tenantRow) {
    console.error(`Tenant '${args.tenant}' not found in nbfc_tenants. Seed it first.`);
    process.exit(1);
  }

  // Step 2: create or fetch Supabase auth user
  let authUserId: string | undefined;

  // Check if a user with this email already exists in Supabase
  const existing = await supabaseAdmin.auth.admin.listUsers();
  const found = existing.data.users.find((u) => u.email?.toLowerCase() === args.email.toLowerCase());

  if (found) {
    authUserId = found.id;
    console.log(`  Supabase auth user already exists: ${authUserId}`);
    // Reset their password to the temp one (they'll be forced to change on first login)
    await supabaseAdmin.auth.admin.updateUserById(authUserId, {
      password: tempPassword,
      user_metadata: { ...found.user_metadata, role: "nbfc_partner" },
      app_metadata: { ...found.app_metadata, role: "nbfc_partner" },
    });
    console.log("  Password rotated to temp value");
  } else {
    const created = await supabaseAdmin.auth.admin.createUser({
      email: args.email,
      password: tempPassword,
      email_confirm: true, // skip the email-confirmation flow for partners
      user_metadata: { name: args.name, role: "nbfc_partner" },
      app_metadata: { role: "nbfc_partner" },
    });
    if (created.error || !created.data.user) {
      console.error("Supabase user create failed:", created.error);
      process.exit(1);
    }
    authUserId = created.data.user.id;
    console.log(`  Supabase auth user created: ${authUserId}`);
  }

  // Step 3: upsert into CRM users table
  await db
    .insert(users)
    .values({
      id: authUserId,
      email: args.email,
      name: args.name,
      role: "nbfc_partner",
      must_change_password: true,
      is_active: true,
    })
    .onConflictDoUpdate({
      target: users.id,
      set: {
        email: args.email,
        name: args.name,
        role: "nbfc_partner",
        must_change_password: true,
        is_active: true,
        updated_at: new Date(),
      },
    });
  console.log("  CRM users row upserted (role=nbfc_partner)");

  // Step 4: link to tenant
  await db
    .insert(nbfcUsers)
    .values({
      user_id: authUserId,
      tenant_id: tenantRow.id,
      role: args.role,
    })
    .onConflictDoNothing();
  console.log(`  nbfc_users membership: tenant=${args.tenant} role=${args.role}`);

  console.log("");
  console.log("==============================================");
  console.log(" Invitation complete. Send these to the user:");
  console.log(`   Login:    your CRM /login URL`);
  console.log(`   Email:    ${args.email}`);
  console.log(`   Password: ${tempPassword}    (one-time; force-change on first login)`);
  console.log("==============================================");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
