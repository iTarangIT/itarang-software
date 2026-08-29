import "./_load-env";

import { eq } from "drizzle-orm";
import { db } from "../src/lib/db";
import { users } from "../src/lib/db/schema";
import { hashPassword } from "../src/lib/auth/hashPassword";
import { supabaseAdmin } from "../src/lib/supabase/admin";

/**
 * Provisions (or repairs) the IT Dashboard login — the single account that can
 * reach /it, /it/security and /it/security/live.
 *
 *   npm run seed:it-user                       → it@itarang.com / password
 *   npx tsx scripts/create-it-user.ts <email> <password> [name]
 *
 * Idempotent: re-running resets the password and re-syncs the role rather than
 * failing on the existing account. The users row is keyed on the Supabase Auth
 * user's ID, never on email — Supabase lowercases emails while users.email is
 * mixed-case, so an email-keyed row is the classic "no session / wrong user"
 * bug in this codebase.
 */

const ROLE = "it";

async function main() {
  const email = (process.argv[2] || "it@itarang.com").trim().toLowerCase();
  const password = (process.argv[3] || "password").trim();
  const name = (process.argv[4] || "IT Admin").trim();

  // 1. Supabase Auth user — create, or reset the password if it already exists.
  const { data: authList, error: listErr } =
    await supabaseAdmin.auth.admin.listUsers();
  if (listErr) throw listErr;

  let authUser = authList?.users?.find(
    (u) => u.email?.toLowerCase() === email,
  );

  if (authUser) {
    const { error } = await supabaseAdmin.auth.admin.updateUserById(
      authUser.id,
      {
        password,
        email_confirm: true,
        // Middleware reads the role off app_metadata; /api/user/profile re-syncs
        // it from RDS on every profile fetch, but seeding it here means the very
        // first navigation after login already routes correctly.
        app_metadata: { ...(authUser.app_metadata ?? {}), role: ROLE },
      },
    );
    if (error) throw error;
    console.log(`[auth] updated existing user ${email} (${authUser.id})`);
  } else {
    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: { role: ROLE },
      user_metadata: { name, role: ROLE },
    });
    if (error) throw error;
    authUser = data.user!;
    console.log(`[auth] created user ${email} (${authUser.id})`);
  }

  // 2. RDS users row — the authoritative role for every page/API gate.
  const password_hash = await hashPassword(password);
  const existingById = (
    await db.select().from(users).where(eq(users.id, authUser.id)).limit(1)
  )[0];

  if (existingById) {
    await db
      .update(users)
      .set({
        email,
        name,
        role: ROLE,
        is_active: true,
        must_change_password: false,
        password_hash,
        updated_at: new Date(),
      })
      .where(eq(users.id, authUser.id));
    console.log("[db] updated users row by id");
  } else {
    // A row may exist under a stale/random id from an earlier hand-created
    // account. Repoint it by id so the id-keyed lookup in auth-utils hits.
    const byEmail = (
      await db.select().from(users).where(eq(users.email, email)).limit(1)
    )[0];

    if (byEmail) {
      await db
        .update(users)
        .set({
          id: authUser.id,
          name,
          role: ROLE,
          is_active: true,
          must_change_password: false,
          password_hash,
          updated_at: new Date(),
        })
        .where(eq(users.email, byEmail.email));
      console.log(`[db] repointed existing users row ${byEmail.id} → ${authUser.id}`);
    } else {
      await db.insert(users).values({
        id: authUser.id,
        email,
        name,
        role: ROLE,
        is_active: true,
        must_change_password: false,
        password_hash,
      });
      console.log("[db] inserted users row");
    }
  }

  const appUrl = (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
  console.log("\n============================================");
  console.log("IT DASHBOARD LOGIN READY");
  console.log("--------------------------------------------");
  console.log("Email   :", email);
  console.log("Password:", password);
  console.log("Role    :", ROLE);
  console.log("Login at:", `${appUrl}/login`);
  console.log("Lands on:", `${appUrl}/it`);
  console.log("============================================\n");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("CREATE IT USER FAILED:", err?.message || err);
    if (err?.cause) console.error("cause:", err.cause);
    process.exit(1);
  });
