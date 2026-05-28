import "dotenv/config";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

import { and, eq } from "drizzle-orm";
import { db } from "../src/lib/db";
import { users } from "../src/lib/db/schema";
import { hashPassword } from "../src/lib/auth/hashPassword";
import { supabaseAdmin } from "../src/lib/supabase/admin";

async function listActiveDealers() {
  const rows = await db
    .select({
      email: users.email,
      name: users.name,
      dealer_id: users.dealer_id,
    })
    .from(users)
    .where(and(eq(users.role, "dealer"), eq(users.is_active, true)));

  console.log(`\nActive dealers (${rows.length}):`);
  console.table(rows);
  console.log(
    "\nUsage: npx tsx scripts/reset-dealer-password.ts <email> [password]",
  );
  console.log('Default password if omitted: "password"\n');
}

async function resetPassword(email: string, password: string) {
  const userRows = await db.select().from(users).where(eq(users.email, email));
  const user = userRows[0];
  if (!user) {
    console.error(`No user found for email=${email}`);
    process.exit(1);
  }
  if (user.role !== "dealer") {
    console.error(
      `User ${email} has role=${user.role}, not 'dealer'. Aborting.`,
    );
    process.exit(1);
  }
  if (!user.is_active) {
    console.error(`User ${email} is inactive. Aborting.`);
    process.exit(1);
  }

  const { data: authUsers, error: listError } =
    await supabaseAdmin.auth.admin.listUsers();
  if (listError) throw listError;
  const authUser = authUsers?.users?.find(
    (u) => u.email?.toLowerCase() === email.toLowerCase(),
  );
  if (!authUser) {
    console.error(`No Supabase Auth user found for email=${email}`);
    process.exit(1);
  }

  const { error: updErr } = await supabaseAdmin.auth.admin.updateUserById(
    authUser.id,
    { password, email_confirm: true },
  );
  if (updErr) throw updErr;

  const newHash = await hashPassword(password);
  await db
    .update(users)
    .set({
      password_hash: newHash,
      must_change_password: false,
      updated_at: new Date(),
    })
    .where(eq(users.email, email));

  console.log("\n============================================");
  console.log("DEALER PASSWORD RESET");
  console.log("--------------------------------------------");
  console.log("Email   :", email);
  console.log("Password:", password);
  console.log("DealerId:", user.dealer_id);
  console.log(
    "Login at:",
    (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "") +
      "/login",
  );
  console.log("============================================\n");
}

async function main() {
  const email = (process.argv[2] || "").trim().toLowerCase();
  const password = (process.argv[3] || "password").trim();

  if (!email) {
    await listActiveDealers();
    process.exit(0);
  }
  await resetPassword(email, password);
  process.exit(0);
}

main().catch((err) => {
  console.error("RESET FAILED:", err?.message || err);
  if (err?.cause) console.error("cause:", err.cause);
  process.exit(1);
});
