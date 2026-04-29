import { desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { dealerOnboardingApplications } from "@/lib/db/schema";

type DealerIdentityLookup = {
  authUserId?: string | null;
  profileUserId?: string | null;
  email?: string | null;
};

function normalizeEmail(email?: string | null) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

export async function findLatestDealerOnboardingApplication(
  identity: DealerIdentityLookup
) {
  const candidateIds = Array.from(
    new Set(
      [identity.authUserId, identity.profileUserId].filter(
        (value): value is string =>
          typeof value === "string" && value.trim().length > 0
      )
    )
  );

  for (const candidateId of candidateIds) {
    const application =
      (
        await db
          .select()
          .from(dealerOnboardingApplications)
          .where(eq(dealerOnboardingApplications.dealer_user_id, candidateId))
          .orderBy(desc(dealerOnboardingApplications.updated_at))
          .limit(1)
      )[0] ?? null;

    if (application) {
      return application;
    }
  }

  const email = normalizeEmail(identity.email);
  if (!email) {
    return null;
  }

  return (
    (
      await db
        .select()
        .from(dealerOnboardingApplications)
        .where(eq(dealerOnboardingApplications.owner_email, email))
        .orderBy(desc(dealerOnboardingApplications.updated_at))
        .limit(1)
    )[0] ?? null
  );
}
