import "dotenv/config";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

import { sql, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "../src/lib/db";
import {
  users,
  accounts,
  dealerOnboardingApplications,
  dealerAgreementSigners,
  dealerAgreementEvents,
  dealerOnboardingDocuments,
  dealerSubscriptions,
} from "../src/lib/db/schema";
import { supabaseAdmin } from "../src/lib/supabase/admin";

const CONFIRM = process.argv.includes("--confirm");

function banner(msg: string) {
  console.log("\n" + "=".repeat(60));
  console.log(msg);
  console.log("=".repeat(60));
}

async function count(table: any, where?: any) {
  const q = db.select({ c: sql<number>`count(*)::int` }).from(table);
  const res = where ? await q.where(where) : await q;
  return Number(res[0]?.c ?? 0);
}

async function main() {
  const dbUrl = process.env.DATABASE_URL || "(unset)";
  const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "(unset)";

  banner("DEALER DATA PURGE");
  console.log("DATABASE_URL :", dbUrl.replace(/:[^:@]+@/, ":****@"));
  console.log("SUPABASE_URL :", supaUrl);
  console.log("Mode         :", CONFIRM ? "LIVE (will delete)" : "DRY RUN");

  const dealerUsers = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.role, "dealer"));

  const dealerUserIds = dealerUsers.map((u) => u.id);
  const dealerEmails = dealerUsers.map((u) => u.email);

  const counts = {
    dealer_onboarding_documents: await count(dealerOnboardingDocuments),
    dealer_agreement_events: await count(dealerAgreementEvents),
    dealer_agreement_signers: await count(dealerAgreementSigners),
    dealer_onboarding_applications: await count(dealerOnboardingApplications),
    dealer_subscriptions: await count(dealerSubscriptions),
    accounts_with_dealer_code: await count(
      accounts,
      isNotNull(accounts.dealer_code),
    ),
    users_role_dealer: dealerUsers.length,
  };

  banner("Rows that will be deleted");
  console.table(counts);

  if (dealerEmails.length) {
    console.log("\nDealer emails (first 20):");
    dealerEmails.slice(0, 20).forEach((e) => console.log("  -", e));
    if (dealerEmails.length > 20)
      console.log(`  ...and ${dealerEmails.length - 20} more`);
  }

  if (!CONFIRM) {
    banner("DRY RUN — no changes made");
    console.log("Re-run with --confirm to actually delete.");
    console.log("  npx tsx scripts/delete-all-dealers.ts --confirm");
    process.exit(0);
  }

  banner("DELETING — 5 second abort window (Ctrl+C)...");
  await new Promise((r) => setTimeout(r, 5000));

  // Order matters: children first, then parents.
  // Many child tables ON DELETE CASCADE from dealer_onboarding_applications,
  // but we delete explicitly for clarity + subscriptions/accounts linkage.

  banner("Deleting dealer_onboarding_documents");
  const d1 = await db.delete(dealerOnboardingDocuments);
  console.log("done");

  banner("Deleting dealer_agreement_events");
  await db.delete(dealerAgreementEvents);
  console.log("done");

  banner("Deleting dealer_agreement_signers");
  await db.delete(dealerAgreementSigners);
  console.log("done");

  banner("Deleting dealer_onboarding_applications");
  await db.delete(dealerOnboardingApplications);
  console.log("done");

  banner("Deleting dealer_subscriptions");
  await db.delete(dealerSubscriptions);
  console.log("done");

  banner("Deleting accounts with dealer_code");
  await db.delete(accounts).where(isNotNull(accounts.dealer_code));
  console.log("done");

  banner("Deleting users WHERE role='dealer'");
  if (dealerUserIds.length) {
    await db.delete(users).where(inArray(users.id, dealerUserIds));
  }
  console.log(`done (${dealerUserIds.length} rows)`);

  banner("Deleting Supabase Auth accounts for dealer emails");
  let deletedAuth = 0;
  let failedAuth: { email: string; error: string }[] = [];
  for (const email of dealerEmails) {
    try {
      // Find auth user by email via listUsers (paginated search)
      const { data: list, error: listErr } =
        await supabaseAdmin.auth.admin.listUsers({
          page: 1,
          perPage: 200,
        });
      if (listErr) throw listErr;
      const match = list.users.find(
        (u) => u.email?.toLowerCase() === email.toLowerCase(),
      );
      if (!match) {
        failedAuth.push({ email, error: "not found in Supabase Auth" });
        continue;
      }
      const { error: delErr } = await supabaseAdmin.auth.admin.deleteUser(
        match.id,
      );
      if (delErr) throw delErr;
      deletedAuth++;
    } catch (e: any) {
      failedAuth.push({ email, error: e?.message || String(e) });
    }
  }
  console.log(`Supabase Auth deleted: ${deletedAuth}/${dealerEmails.length}`);
  if (failedAuth.length) {
    console.log("Failures:");
    failedAuth.forEach((f) => console.log(`  - ${f.email}: ${f.error}`));
  }

  banner("DONE");
  process.exit(0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
