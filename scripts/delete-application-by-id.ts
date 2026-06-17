import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

import { eq, or } from "drizzle-orm";

const CONFIRM = process.argv.includes("--confirm");
const appId = (process.argv[2] || "").trim();

async function main() {
  // Dynamic imports so .env.local is loaded before db/index.ts reads DATABASE_URL.
  const { db } = await import("../src/lib/db");
  const {
    users,
    dealerOnboardingApplications,
    dealerOnboardingDocuments,
    dealerAgreementSigners,
    dealerAgreementEvents,
    dealerCorrectionRounds,
    whatsappOnboardingSessions,
  } = await import("../src/lib/db/schema");
  const { supabaseAdmin } = await import("../src/lib/supabase/admin");

  if (!appId || appId.startsWith("--")) {
    console.error(
      "Usage: npx tsx scripts/delete-application-by-id.ts <applicationId> [--confirm]",
    );
    process.exit(1);
  }

  const dbUrl = process.env.DATABASE_URL || "(unset)";
  console.log("DATABASE_URL :", dbUrl.replace(/:[^:@]+@/, ":****@"));
  console.log("Application  :", appId);
  console.log("Mode         :", CONFIRM ? "LIVE" : "DRY RUN");
  console.log("");

  const apps = await db
    .select()
    .from(dealerOnboardingApplications)
    .where(eq(dealerOnboardingApplications.id, appId));

  if (!apps.length) {
    console.error("No dealer_onboarding_applications row with that id. Aborting.");
    process.exit(1);
  }
  const app = apps[0];
  console.log("Application found:");
  console.log("  company       :", app.company_name);
  console.log("  owner_name    :", app.owner_name);
  console.log("  owner_email   :", app.owner_email);
  console.log("  owner_phone   :", app.owner_phone);
  console.log("  dealer_user_id:", app.dealer_user_id);
  console.log("  onboarding    :", app.onboarding_status);
  console.log("  review        :", app.review_status);
  console.log("  agreement     :", app.agreement_status);
  console.log("");

  const docs = await db
    .select()
    .from(dealerOnboardingDocuments)
    .where(eq(dealerOnboardingDocuments.application_id, appId));
  const signers = await db
    .select()
    .from(dealerAgreementSigners)
    .where(eq(dealerAgreementSigners.application_id, appId));
  const events = await db
    .select()
    .from(dealerAgreementEvents)
    .where(eq(dealerAgreementEvents.application_id, appId));
  const rounds = await db
    .select()
    .from(dealerCorrectionRounds)
    .where(eq(dealerCorrectionRounds.application_id, appId));
  const sessions = await db
    .select()
    .from(whatsappOnboardingSessions)
    .where(
      app.owner_phone
        ? or(
            eq(whatsappOnboardingSessions.application_id, appId),
            eq(whatsappOnboardingSessions.wa_phone, app.owner_phone),
          )
        : eq(whatsappOnboardingSessions.application_id, appId),
    );

  console.log("Related rows:");
  console.log("  dealer_onboarding_documents :", docs.length);
  console.log("  dealer_agreement_signers    :", signers.length);
  console.log("  dealer_agreement_events     :", events.length);
  console.log("  dealer_correction_rounds    :", rounds.length);
  console.log(
    "  whatsapp_onboarding_sessions:",
    sessions.length,
    sessions.map((s) => `${s.wa_phone}/${s.current_state}/${s.session_status}`),
  );
  console.log("");

  // Auth / users lookup by owner_email (only if an account was actually created)
  const email = (app.owner_email || "").trim().toLowerCase();
  let dbUsers: typeof users.$inferSelect[] = [];
  let authMatch: { id: string } | undefined;
  if (email) {
    dbUsers = await db.select().from(users).where(eq(users.email, email));
    const { data: list } = await supabaseAdmin.auth.admin.listUsers({
      page: 1,
      perPage: 1000,
    });
    authMatch = list?.users.find((u) => u.email?.toLowerCase() === email);
  }
  console.log("Postgres users row :", dbUsers.length ? "FOUND" : "none");
  console.log("Supabase Auth user :", authMatch ? "FOUND" : "none");

  if (!CONFIRM) {
    console.log("\nDRY RUN — re-run with --confirm to delete.");
    process.exit(0);
  }

  console.log("\nDeleting...");

  await db
    .delete(dealerOnboardingDocuments)
    .where(eq(dealerOnboardingDocuments.application_id, appId));
  console.log(`- ${docs.length} documents deleted`);

  await db
    .delete(dealerAgreementSigners)
    .where(eq(dealerAgreementSigners.application_id, appId));
  console.log(`- ${signers.length} agreement signers deleted`);

  await db
    .delete(dealerAgreementEvents)
    .where(eq(dealerAgreementEvents.application_id, appId));
  console.log(`- ${events.length} agreement events deleted`);

  // dealer_correction_rounds has ON DELETE CASCADE, but delete explicitly anyway
  await db
    .delete(dealerCorrectionRounds)
    .where(eq(dealerCorrectionRounds.application_id, appId));
  console.log(`- ${rounds.length} correction rounds deleted`);

  for (const s of sessions) {
    await db
      .delete(whatsappOnboardingSessions)
      .where(eq(whatsappOnboardingSessions.id, s.id));
  }
  console.log(`- ${sessions.length} whatsapp sessions deleted`);

  await db
    .delete(dealerOnboardingApplications)
    .where(eq(dealerOnboardingApplications.id, appId));
  console.log("- application deleted");

  if (dbUsers.length) {
    await db.delete(users).where(eq(users.email, email));
    console.log("- users row deleted");
  }
  if (authMatch) {
    const { error } = await supabaseAdmin.auth.admin.deleteUser(authMatch.id);
    if (error) console.error("- Supabase Auth delete error:", error.message);
    else console.log("- Supabase Auth user deleted");
  }

  console.log("\nDone. The dealer can now re-onboard via WhatsApp.");
  process.exit(0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
