import "dotenv/config";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

import { eq } from "drizzle-orm";
import { db } from "../src/lib/db";
import {
  users,
  dealerOnboardingApplications,
} from "../src/lib/db/schema";
import { supabaseAdmin } from "../src/lib/supabase/admin";

const CONFIRM = process.argv.includes("--confirm");
const email = (process.argv[2] || "").trim().toLowerCase();

async function main() {
  if (!email || email.startsWith("--")) {
    console.error("Usage: npx tsx scripts/delete-dealer-by-email.ts <email> [--confirm]");
    process.exit(1);
  }

  const dbUrl = process.env.DATABASE_URL || "(unset)";
  const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "(unset)";
  console.log("DATABASE_URL :", dbUrl.replace(/:[^:@]+@/, ":****@"));
  console.log("SUPABASE_URL :", supaUrl);
  console.log("Email        :", email);
  console.log("Mode         :", CONFIRM ? "LIVE" : "DRY RUN");
  console.log("");

  const dbUsers = await db.select().from(users).where(eq(users.email, email));
  const apps = await db
    .select()
    .from(dealerOnboardingApplications)
    .where(eq(dealerOnboardingApplications.ownerEmail, email));

  const { data: list, error: listErr } =
    await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (listErr) {
    console.error("listUsers error:", listErr.message);
    process.exit(1);
  }
  const authMatch = list.users.find(
    (u) => u.email?.toLowerCase() === email,
  );

  console.log("Postgres users row       :", dbUsers.length ? "FOUND" : "none");
  if (dbUsers[0]) {
    console.log("  role :", dbUsers[0].role);
    console.log("  id   :", dbUsers[0].id);
  }
  console.log("dealer_onboarding_apps  :", apps.length);
  console.log("Supabase Auth user       :", authMatch ? "FOUND" : "none");
  if (authMatch) {
    console.log("  id       :", authMatch.id);
    console.log("  metadata :", JSON.stringify(authMatch.user_metadata));
  }

  if (!CONFIRM) {
    console.log("\nDRY RUN — re-run with --confirm to delete.");
    process.exit(0);
  }

  console.log("\nDeleting...");

  if (dbUsers.length) {
    await db.delete(users).where(eq(users.email, email));
    console.log("- users row deleted");
  }

  if (authMatch) {
    const { error } = await supabaseAdmin.auth.admin.deleteUser(authMatch.id);
    if (error) console.error("- Supabase Auth delete error:", error.message);
    else console.log("- Supabase Auth user deleted");
  }

  console.log("\nDone. Try approving the dealer application again.");
  process.exit(0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
