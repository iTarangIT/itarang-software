import "dotenv/config";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

import { eq } from "drizzle-orm";
import { db } from "../src/lib/db";
import {
  dealerOnboardingApplications,
  users,
  accounts,
} from "../src/lib/db/schema";
import { generateTemporaryPassword } from "../src/lib/auth/generateTemporaryPassword";
import { hashPassword } from "../src/lib/auth/hashPassword";
import { supabaseAdmin } from "../src/lib/supabase/admin";

function generateDealerCode() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const random = Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, "0");
  return `ACC-ITARANG-${yyyy}${mm}${dd}-${random}`;
}

async function main() {
  const email = (process.argv[2] || "").trim().toLowerCase();
  if (!email) {
    console.error("Usage: npx tsx scripts/approve-dealer.ts <owner_email>");
    process.exit(1);
  }

  const rows = await db
    .select()
    .from(dealerOnboardingApplications)
    .where(eq(dealerOnboardingApplications.owner_email, email));

  const application = rows[0];
  if (!application) {
    console.error(`No dealer application found for ownerEmail=${email}`);
    process.exit(1);
  }

  console.log("Current state:", {
    id: application.id,
    companyName: application.company_name,
    onboardingStatus: application.onboarding_status,
    reviewStatus: application.review_status,
    financeEnabled: application.finance_enabled,
    agreementStatus: application.agreement_status,
    dealerCode: application.dealer_code,
    dealerUserId: application.dealer_user_id,
  });

  if (application.onboarding_status === "approved") {
    console.log(
      `Already approved. dealerCode=${application.dealer_code}. Issuing a fresh temp password so you can log in.`,
    );
  }

  const dealerCode = application.dealer_code || generateDealerCode();
  const dealerLoginEmail = application.owner_email?.trim() || email;

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  const { data: authUsers, error: listError } =
    await supabaseAdmin.auth.admin.listUsers();
  if (listError) throw listError;

  const existingAuthUser = authUsers?.users?.find(
    (u) => u.email?.toLowerCase() === dealerLoginEmail.toLowerCase(),
  );

  let authUserId: string;
  if (existingAuthUser) {
    const { data: updated, error } =
      await supabaseAdmin.auth.admin.updateUserById(existingAuthUser.id, {
        password: temporaryPassword,
        email_confirm: true,
        user_metadata: { role: "dealer", dealer_code: dealerCode },
      });
    if (error) throw error;
    authUserId = updated.user.id;
    console.log("Reused existing Supabase Auth user:", authUserId);
  } else {
    const { data: created, error } = await supabaseAdmin.auth.admin.createUser({
      email: dealerLoginEmail,
      password: temporaryPassword,
      email_confirm: true,
      user_metadata: { role: "dealer", dealer_code: dealerCode },
    });
    if (error) throw error;
    authUserId = created.user.id;
    console.log("Created new Supabase Auth user:", authUserId);
  }

  await db.transaction(async (tx) => {
    await tx
      .update(dealerOnboardingApplications)
      .set({
        dealer_user_id: authUserId,
        onboarding_status: "approved",
        review_status: "approved",
        dealer_account_status: "active",
        completion_status: "completed",
        approved_at: new Date(),
        signed_at:
          application.agreement_status === "completed"
            ? application.signed_at || new Date()
            : application.signed_at || null,
        rejected_at: null,
        rejection_reason: null,
        correction_remarks: null,
        rejection_remarks: null,
        dealer_code: dealerCode,
        updated_at: new Date(),
      })
      .where(eq(dealerOnboardingApplications.id, application.id));

    const existingAccount = await tx
      .select()
      .from(accounts)
      .where(eq(accounts.id, dealerCode))
      .limit(1);

    if (existingAccount.length === 0) {
      const addressObj =
        typeof application.business_address === "object" &&
        application.business_address
          ? (application.business_address as Record<string, any>)
          : null;

      await tx.insert(accounts).values({
        id: dealerCode,
        business_entity_name: application.company_name || "Dealer Business",
        gstin: application.gst_number || "PENDING",
        pan: application.pan_number || null,
        dealer_code: dealerCode,
        contact_name:
          application.owner_name || application.company_name || "Dealer",
        contact_email: dealerLoginEmail,
        contact_phone: application.owner_phone || null,
        address_line1: addressObj?.address || addressObj?.line1 || null,
        city: addressObj?.city || null,
        state: addressObj?.state || null,
        pincode: addressObj?.pincode || null,
        bank_name: application.bank_name || null,
        bank_account_number: application.account_number || null,
        ifsc_code: application.ifsc_code || null,
        status: "active",
        onboarding_status: "approved",
        created_by: authUserId,
      });
    }

    const existingUserRows = await tx
      .select()
      .from(users)
      .where(eq(users.email, dealerLoginEmail));

    if (existingUserRows[0]) {
      await tx
        .update(users)
        .set({
          id: authUserId,
          name:
            application.owner_name || application.company_name || "Dealer",
          role: "dealer",
          dealer_id: dealerCode,
          phone: application.owner_phone || null,
          is_active: true,
          password_hash: passwordHash,
          must_change_password: true,
          updated_at: new Date(),
        })
        .where(eq(users.email, dealerLoginEmail));
    } else {
      await tx.insert(users).values({
        id: authUserId,
        email: dealerLoginEmail,
        name: application.owner_name || application.company_name || "Dealer",
        role: "dealer",
        dealer_id: dealerCode,
        phone: application.owner_phone || null,
        avatar_url: null,
        password_hash: passwordHash,
        must_change_password: true,
        is_active: true,
        created_at: new Date(),
        updated_at: new Date(),
      });
    }
  });

  console.log("\n============================================");
  console.log("DEALER APPROVED");
  console.log("--------------------------------------------");
  console.log("Email   :", dealerLoginEmail);
  console.log("Password:", temporaryPassword);
  console.log("DealerCd:", dealerCode);
  console.log("AuthId  :", authUserId);
  console.log("Login at: http://localhost:3000/login");
  console.log("============================================\n");

  process.exit(0);
}

main().catch((err) => {
  console.error("APPROVE SCRIPT FAILED:", err?.message || err);
  if (err?.cause) console.error("cause:", err.cause);
  process.exit(1);
});
