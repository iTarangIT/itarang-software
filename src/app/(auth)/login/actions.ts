"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { db } from "@/lib/db";
import { dealerOnboardingApplications, users } from "@/lib/db/schema";
import { desc, eq, or } from "drizzle-orm";

function resolveDealerRedirect(application?: {
  onboardingStatus?: string | null;
  reviewStatus?: string | null;
  dealerAccountStatus?: string | null;
}) {
  const onboardingStatus = (application?.onboardingStatus || "draft").toLowerCase();
  const reviewStatus = (application?.reviewStatus || "").toLowerCase();
  const dealerAccountStatus = (application?.dealerAccountStatus || "").toLowerCase();

  if (onboardingStatus === "approved" && dealerAccountStatus === "active") {
    return "/dealer-portal";
  }

  if (
    onboardingStatus === "submitted" ||
    reviewStatus === "pending_sales_head" ||
    reviewStatus === "pending_admin_review" ||
    reviewStatus === "under_review" ||
    reviewStatus === "agreement_in_progress" ||
    reviewStatus === "agreement_completed" ||
    onboardingStatus === "rejected"
  ) {
    return "/dealer-portal/onboarding-status";
  }

  if (
    onboardingStatus === "correction_requested" ||
    onboardingStatus === "action_needed"
  ) {
    return "/dealer-onboarding";
  }

  return "/dealer-onboarding";
}

export async function login(formData: FormData) {
  const supabase = await createClient();

  const email = String(formData.get("email") || "").trim().toLowerCase();
  const password = String(formData.get("password") || "");

  if (!email || !password) {
    redirect("/login?error=Email and password are required");
  }

  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    console.error("[LOGIN] Supabase login failed:", error.message);
    redirect("/login?error=Could not authenticate user");
  }

  const matchedUsers = await db
    .select()
    .from(users)
    .where(
      data.user?.id
        ? or(eq(users.id, data.user.id), eq(users.email, email))
        : eq(users.email, email)
    )
    .limit(1);

  const appUser = matchedUsers[0];

  if (!appUser) {
    const authUserId = data.user?.id;

    const onboardingApplication =
      (
        await db
          .select({
            onboardingStatus: dealerOnboardingApplications.onboardingStatus,
            reviewStatus: dealerOnboardingApplications.reviewStatus,
            dealerAccountStatus:
              dealerOnboardingApplications.dealerAccountStatus,
          })
          .from(dealerOnboardingApplications)
          .where(
            authUserId
              ? or(
                  eq(dealerOnboardingApplications.dealerUserId, authUserId),
                  eq(dealerOnboardingApplications.ownerEmail, email)
                )
              : eq(dealerOnboardingApplications.ownerEmail, email)
          )
          .orderBy(desc(dealerOnboardingApplications.updatedAt))
          .limit(1)
      )[0] ?? null;

    if (onboardingApplication) {
      console.log("[LOGIN] Dealer onboarding record found without local users row:", {
        email,
        onboardingStatus: onboardingApplication.onboardingStatus,
        reviewStatus: onboardingApplication.reviewStatus,
        dealerAccountStatus: onboardingApplication.dealerAccountStatus,
      });

      redirect(resolveDealerRedirect(onboardingApplication));
    }

    console.error("[LOGIN] Local app user not found for:", email);
    redirect("/login?error=User record not found");
  }

  if (!appUser.is_active) {
    console.error("[LOGIN] Inactive user:", email);
    redirect("/login?error=User is inactive");
  }

  console.log("[LOGIN] User found:", {
    email: appUser.email,
    role: appUser.role,
    must_change_password: appUser.must_change_password,
    is_active: appUser.is_active,
    dealer_id: appUser.dealer_id,
  });

  revalidatePath("/", "layout");

  if (appUser.must_change_password) {
    redirect("/change-password");
  }

  if (appUser.role === "dealer") {
    const authUserId = data.user?.id;

    const onboardingApplication =
      (
        await db
          .select({
            onboardingStatus: dealerOnboardingApplications.onboardingStatus,
            reviewStatus: dealerOnboardingApplications.reviewStatus,
            dealerAccountStatus:
              dealerOnboardingApplications.dealerAccountStatus,
          })
          .from(dealerOnboardingApplications)
          .where(
            authUserId
              ? or(
                  eq(dealerOnboardingApplications.dealerUserId, authUserId),
                  eq(dealerOnboardingApplications.ownerEmail, email)
                )
              : eq(dealerOnboardingApplications.ownerEmail, email)
          )
          .orderBy(desc(dealerOnboardingApplications.updatedAt))
          .limit(1)
      )[0] ?? null;

    redirect(resolveDealerRedirect(onboardingApplication || undefined));
  }

  if (appUser.role === "admin") {
    redirect("/admin");
  }

  redirect("/");
}

export async function signup(formData: FormData) {
  const supabase = await createClient();

  const email = String(formData.get("email") || "").trim().toLowerCase();
  const password = String(formData.get("password") || "");

  if (!email || !password) {
    redirect("/login?error=Email and password are required");
  }

  const { error } = await supabase.auth.signUp({
    email,
    password,
  });

  if (error) {
    console.error("[SIGNUP] Supabase signup failed:", error.message);
    redirect("/login?error=Could not authenticate user");
  }

  revalidatePath("/", "layout");
  redirect("/");
}
