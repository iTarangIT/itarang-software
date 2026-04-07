import { db } from "./db";
import { users, dealerOnboardingApplications } from "./db/schema";
import { eq, desc } from "drizzle-orm";
import { createClient } from "./supabase/server";
import { normalizeRole } from "./roles";
import { findSupabaseUserProfile } from "./supabase/identity";

type AuthIdentity = {
  id: string;
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
  app_metadata?: Record<string, unknown> | null;
};

function getAuthMetadataValue(authUser: AuthIdentity, key: string) {
  const userValue = authUser.user_metadata?.[key];
  if (typeof userValue === "string" && userValue.trim()) {
    return userValue;
  }

  const appValue = authUser.app_metadata?.[key];
  if (typeof appValue === "string" && appValue.trim()) {
    return appValue;
  }

  return null;
}

function buildFallbackUser(authUser: AuthIdentity) {
  return {
    id: authUser.id,
    name: getAuthMetadataValue(authUser, "name") || authUser.email?.split("@")[0] || "User",
    email: authUser.email || "",
    role: normalizeRole(getAuthMetadataValue(authUser, "role")),
    dealer_id: null,
    onboarding_status: null,
    review_status: null,
    dealer_account_status: null,
  };
}

export class AuthError extends Error {
  status: number;

  constructor(message = "Unauthorized", status = 401) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

export async function requireAuth() {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    throw new AuthError("Unauthorized", 401);
  }

  const fallbackUser = buildFallbackUser(user);

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

    const resolvedUser = dbUser
      ? {
          ...dbUser,
          role: normalizeRole(dbUser.role),
        }
      : null;

    if (!resolvedUser) {
      const supabaseProfile = await findSupabaseUserProfile<{
        id: string;
        email?: string | null;
        name?: string | null;
        role?: string | null;
        dealer_id?: string | null;
        phone?: string | null;
        avatar_url?: string | null;
        must_change_password?: boolean | null;
        is_active?: boolean | null;
        created_at?: string | Date | null;
        updated_at?: string | Date | null;
      }>(
        supabase,
        user,
        "id,email,name,role,dealer_id,phone,avatar_url,must_change_password,is_active,created_at,updated_at"
      );

      if (supabaseProfile) {
        const normalizedSupabaseUser = {
          ...fallbackUser,
          ...supabaseProfile,
          role: normalizeRole(supabaseProfile.role),
        };

        if (normalizedSupabaseUser.role === "dealer") {
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
                .where(eq(dealerOnboardingApplications.dealerUserId, normalizedSupabaseUser.id))
                .orderBy(desc(dealerOnboardingApplications.updatedAt))
                .limit(1)
            )[0] ?? null;

          return {
            ...normalizedSupabaseUser,
            onboarding_status: onboarding?.onboarding_status || null,
            review_status: onboarding?.review_status || null,
            dealer_account_status: onboarding?.dealer_account_status || null,
          };
        }

        return {
          ...normalizedSupabaseUser,
          onboarding_status: null,
          review_status: null,
          dealer_account_status: null,
        };
      }
    }

    if (!resolvedUser) {
      console.log(
        `[Auth] No DB user found for auth user: ${user.id} / ${user.email}`
      );

      return fallbackUser;
    }

    if (resolvedUser.role === "dealer") {
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
            .where(eq(dealerOnboardingApplications.dealerUserId, resolvedUser.id))
            .orderBy(desc(dealerOnboardingApplications.updatedAt))
            .limit(1)
        )[0] ?? null;

      return {
        ...resolvedUser,
        onboarding_status: onboarding?.onboarding_status || null,
        review_status: onboarding?.review_status || null,
        dealer_account_status: onboarding?.dealer_account_status || null,
      };
    }

    return {
      ...resolvedUser,
      onboarding_status: null,
      review_status: null,
      dealer_account_status: null,
    };
  } catch (dbErr: unknown) {
    console.error("[Auth] Database error in requireAuth (fallback to auth identity):", dbErr);

    return fallbackUser;
  }
}

export async function requireRole(roles: string[]) {
  const user = await requireAuth();

  if (!roles.includes(user.role)) {
    throw new AuthError("Forbidden: Insufficient permissions", 403);
  }

  return user;
}
