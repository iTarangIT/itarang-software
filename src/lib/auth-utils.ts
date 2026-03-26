import { db } from "./db";
import { users, dealerOnboardingApplications } from "./db/schema";
import { eq, desc } from "drizzle-orm";
import { createClient } from "./supabase/server";
import { redirect } from "next/navigation";

export async function requireAuth() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  try {
    let dbUser =
      (
        await db
          .select()
          .from(users)
          .where(eq(users.id, user.id))
          .limit(1)
      )[0] ?? null;

    // Fallback by email in case older rows were created with a random UUID
    if (!dbUser && user.email) {
      dbUser =
        (
          await db
            .select()
            .from(users)
            .where(eq(users.email, user.email))
            .limit(1)
        )[0] ?? null;
    }

    if (!dbUser) {
      console.log(
        `[Auth] No DB user found for auth user: ${user.id} / ${user.email}`
      );

      return {
        id: user.id,
        name: user.email?.split("@")[0] || "User",
        email: user.email || "",
        role: "user",
        dealer_id: null,
        onboarding_status: null,
        review_status: null,
        dealer_account_status: null,
      };
    }

    // For dealer users, also return onboarding/account status
    if (dbUser.role === "dealer") {
      const onboarding =
        (
          await db
            .select({
              onboarding_status: dealerOnboardingApplications.onboardingStatus,
              review_status: dealerOnboardingApplications.reviewStatus,
              dealer_account_status:
                dealerOnboardingApplications.dealerAccountStatus,
            })
            .from(dealerOnboardingApplications)
            .where(eq(dealerOnboardingApplications.dealerUserId, dbUser.id))
            .orderBy(desc(dealerOnboardingApplications.updatedAt))
            .limit(1)
        )[0] ?? null;

      return {
        ...dbUser,
        onboarding_status: onboarding?.onboarding_status || null,
        review_status: onboarding?.review_status || null,
        dealer_account_status: onboarding?.dealer_account_status || null,
      };
    }

    return {
      ...dbUser,
      onboarding_status: null,
      review_status: null,
      dealer_account_status: null,
    };
  } catch (dbErr) {
    console.error("[Auth] Database error in requireAuth:", dbErr);
    throw dbErr;
  }
}

export async function requireRole(roles: string[]) {
  const user = await requireAuth();

  if (!roles.includes(user.role)) {
    throw new Error("Forbidden: Insufficient permissions");
  }

  return user;
}