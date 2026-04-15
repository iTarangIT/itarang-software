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
  if (!email) {
    return null;
  }

  const { data: profileByEmail } = await supabase
    .from("users")
    .select(selectClause)
    .eq("email", email)
    .maybeSingle();

  return (profileByEmail as T | null) ?? null;
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
