import { eq, sql } from "drizzle-orm";

import { db } from "@/lib/db/index";
import { users } from "@/lib/db/schema";
import { normalizeRole } from "@/lib/roles";

export type AuthUserIdentity = {
  id: string;
  email?: string | null;
};

type DealerProfileRecord = {
  id?: string | null;
  email?: string | null;
  role?: string | null;
  dealer_id?: string | null;
};

type ResolvedDealerProfile<T extends DealerProfileRecord> = Omit<
  T,
  "dealer_id" | "role"
> & {
  dealer_id: string;
  role: string;
};

function normalizeEmail(email?: string | null) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

// The columns any caller of these resolvers may ask for. App data lives on AWS
// RDS (drizzle `db`), NOT in the Supabase project's Postgres — see the
// fallback below.
const APP_DB_USER_COLUMNS = {
  id: users.id,
  email: users.email,
  role: users.role,
  dealer_id: users.dealer_id,
} as const;

/**
 * The APP database's users row for an auth user, matched by id first and then
 * by case-insensitive email (Supabase Auth lowercases emails; users.email is
 * mixed-case, so a case-sensitive match silently finds nothing). Returns only
 * the columns the PostgREST-style selectClause asked for, so callers see the
 * same shape either way. Null on any error — resolvers must not throw.
 */
async function findAppDbUserProfile<
  T extends Record<string, unknown> = Record<string, unknown>,
>(authUser: AuthUserIdentity, selectClause: string): Promise<T | null> {
  const wanted = selectClause
    .split(",")
    .map((k) => k.trim())
    .filter((k): k is keyof typeof APP_DB_USER_COLUMNS => k in APP_DB_USER_COLUMNS);
  if (wanted.length === 0) return null;
  const selection = Object.fromEntries(
    wanted.map((k) => [k, APP_DB_USER_COLUMNS[k]]),
  );
  try {
    let [row] = await db
      .select(selection)
      .from(users)
      .where(eq(users.id, authUser.id))
      .limit(1);
    if (!row) {
      const email = normalizeEmail(authUser.email);
      if (!email) return null;
      [row] = await db
        .select(selection)
        .from(users)
        .where(eq(sql`lower(${users.email})`, email))
        .limit(1);
    }
    return (row as T | undefined) ?? null;
  } catch (err) {
    console.error("[supabase/identity] app-DB user lookup failed:", err);
    return null;
  }
}

export async function findSupabaseUserProfile<
  T extends Record<string, unknown> = Record<string, unknown>,
>(supabase: any, authUser: AuthUserIdentity, selectClause: string) {
  const { data: profileById } = await supabase
    .from("users")
    .select(selectClause)
    .eq("id", authUser.id)
    .maybeSingle();

  if (profileById) {
    return profileById as T;
  }

  const email = normalizeEmail(authUser.email);
  if (email) {
    const { data: profileByEmail } = await supabase
      .from("users")
      .select(selectClause)
      .eq("email", email)
      .maybeSingle();
    if (profileByEmail) {
      return profileByEmail as T;
    }
  }

  // The Supabase project's Postgres has NO public.users table any more — app
  // data moved to AWS RDS, so the PostgREST reads above return null for
  // EVERYONE (the error is invisible here: only .data is read). Without this
  // fallback every route that resolves a profile through this helper answers
  // 401/403 to perfectly valid dealers — the dealer-portal Team page's
  // "Unauthorized" was exactly that.
  return await findAppDbUserProfile<T>(authUser, selectClause);
}

export async function resolveDealerProfile<
  T extends DealerProfileRecord = DealerProfileRecord,
>(
  supabase: any,
  authUser: AuthUserIdentity,
  selectClause = "id,email,role,dealer_id"
) : Promise<ResolvedDealerProfile<T> | null> {
  const profile = await findSupabaseUserProfile<T>(
    supabase,
    authUser,
    selectClause
  );

  if (!profile) {
    return null;
  }

  const normalizedRole = normalizeRole(profile.role);
  if (normalizedRole !== "dealer" || !profile.dealer_id) {
    return null;
  }

  return {
    ...profile,
    dealer_id: profile.dealer_id,
    role: normalizedRole,
  } as ResolvedDealerProfile<T>;
}

export async function findLatestDealerOnboardingRecord<
  T extends Record<string, unknown> = Record<string, unknown>,
>(
  supabase: any,
  authUser: AuthUserIdentity,
  options?: {
    profileUserId?: string | null;
    selectClause?: string;
  }
) {
  const candidateIds = Array.from(
    new Set(
      [authUser.id, options?.profileUserId].filter(
        (value): value is string =>
          typeof value === "string" && value.trim().length > 0
      )
    )
  );

  const selectClause = options?.selectClause || "*";

  for (const candidateId of candidateIds) {
    const { data } = await supabase
      .from("dealer_onboarding_applications")
      .select(selectClause)
      .eq("dealer_user_id", candidateId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (data) {
      return data as T;
    }
  }

  const email = normalizeEmail(authUser.email);
  if (!email) {
    return null;
  }

  const { data } = await supabase
    .from("dealer_onboarding_applications")
    .select(selectClause)
    .eq("owner_email", email)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return (data as T | null) ?? null;
}
