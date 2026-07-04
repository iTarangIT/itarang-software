/**
 * Create (or update) an NBFC Risk Head login for the two-person battery
 * immobilisation gate. Idempotent — safe to re-run.
 *
 *   tsx scripts/create-nbfc-riskhead.ts
 *
 * Creates riskhead@itarang.com / password as role `nbfc_risk_head` in the
 * iTarang Finance tenant (nbfc-lryx1chs). must_change_password is false so the
 * given password is the working credential.
 */
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local" });
loadDotenv();

const EMAIL = "riskhead@itarang.com";
const NAME = "Risk Head";
const PASSWORD = "password";
const TENANT_SLUG = "nbfc-lryx1chs"; // iTarang Finance — the tenant with loans
const NBFC_ROLE = "nbfc_risk_head";

async function main() {
  const { db } = await import("@/lib/db");
  const { nbfcTenants, nbfcUsers, users } = await import("@/lib/db/schema");
  const { supabaseAdmin } = await import("@/lib/supabase/admin");
  const { and, eq, sql } = await import("drizzle-orm");

  // 1. Supabase Auth user (create, or reset password if it already exists).
  let userId: string;
  const { data: created, error } = await supabaseAdmin.auth.admin.createUser({
    email: EMAIL,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: { name: NAME, role: "nbfc_partner" },
    app_metadata: { role: "nbfc_partner" },
  });
  if (created?.user?.id) {
    userId = created.user.id;
    console.log(`✓ Supabase auth user created: ${userId}`);
  } else if (error && /already|exists|registered/i.test(error.message ?? "")) {
    const { data: list } = await supabaseAdmin.auth.admin.listUsers({
      page: 1,
      perPage: 200,
    });
    const found = list?.users?.find(
      (u) => (u.email ?? "").toLowerCase() === EMAIL.toLowerCase(),
    );
    if (!found?.id) throw new Error("User exists but could not be located");
    userId = found.id;
    await supabaseAdmin.auth.admin.updateUserById(userId, {
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { name: NAME, role: "nbfc_partner" },
      app_metadata: { role: "nbfc_partner" },
    });
    console.log(`✓ Supabase auth user existed; password reset: ${userId}`);
  } else {
    throw error ?? new Error("Failed to create Supabase auth user");
  }

  // 2. CRM users row (role nbfc_partner; password not forced to change).
  await db
    .insert(users)
    .values({
      id: userId,
      email: EMAIL,
      name: NAME,
      role: "nbfc_partner",
      must_change_password: false,
      is_active: true,
    })
    .onConflictDoUpdate({
      target: users.id,
      set: {
        email: EMAIL,
        name: NAME,
        role: "nbfc_partner",
        must_change_password: false,
        is_active: true,
        updated_at: new Date(),
      },
    });
  console.log(`✓ users row upserted (role=nbfc_partner)`);

  // 3. Resolve tenant.
  const [tenant] = await db
    .select({ id: nbfcTenants.id, name: nbfcTenants.display_name })
    .from(nbfcTenants)
    .where(eq(nbfcTenants.slug, TENANT_SLUG))
    .limit(1);
  if (!tenant) throw new Error(`Tenant ${TENANT_SLUG} not found`);
  console.log(`✓ Tenant: ${tenant.name} (${tenant.id})`);

  // 4. nbfc_users membership with role nbfc_risk_head (insert or update role).
  const existing = await db
    .select({ role: nbfcUsers.role })
    .from(nbfcUsers)
    .where(and(eq(nbfcUsers.user_id, userId), eq(nbfcUsers.tenant_id, tenant.id)))
    .limit(1);
  if (existing[0]) {
    await db
      .update(nbfcUsers)
      .set({ role: NBFC_ROLE, role_id: null })
      .where(
        and(eq(nbfcUsers.user_id, userId), eq(nbfcUsers.tenant_id, tenant.id)),
      );
    console.log(`✓ nbfc_users role updated → ${NBFC_ROLE}`);
  } else {
    // Raw insert mirrors the activation route (bypasses any default + satisfies
    // the nbfc_users_role_check constraint which already allows nbfc_risk_head).
    await db.execute(sql`
      INSERT INTO nbfc_users (user_id, tenant_id, role)
      VALUES (${userId}::uuid, ${tenant.id}::uuid, ${NBFC_ROLE})
    `);
    console.log(`✓ nbfc_users row inserted (role=${NBFC_ROLE})`);
  }

  console.log("\n=== DONE ===");
  console.log(`  Login: /login`);
  console.log(`  Email: ${EMAIL}`);
  console.log(`  Password: ${PASSWORD}`);
  console.log(`  Role: ${NBFC_ROLE} @ ${tenant.name}`);
  console.log(`  Lands on: /risk-head/approvals`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .then(() => process.exit(0));
