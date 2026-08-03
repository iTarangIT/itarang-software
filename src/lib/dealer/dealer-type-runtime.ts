// Resolve a logged-in dealer's business type (E-202) server-side.
//
// SERVER ONLY — it queries the DB. The pure half (what a type is allowed to do)
// lives in dealer-capabilities.ts and is safe to import anywhere.
//
// ON users.dealer_id
//   schema.ts:46 documents it as the value joined against `dealers` by
//   dealer_code; /api/user/profile/details:39 documents it as an accounts.id.
//   Both are correct and it is ONE value: at approval the same `dealerCode`
//   string is written to accounts.id (the PK), dealers.dealer_id, and
//   users.dealer_id (approve/route.ts:708 and :639). So a single lookup against
//   `dealers` by that column is exact, not a guess.
//
// It is only NULL before approval, which is why the onboarding application is
// the fallback rather than the primary source — an unapproved dealer still has
// a type, chosen at Step 1.

import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { dealers } from "@/lib/db/schema";
import { findLatestDealerOnboardingApplication } from "@/lib/dealer-onboarding";
import { normalizeDealerType, type DealerTypeValue } from "./dealer-type";

type DealerIdentity = {
  /** users.id */
  id?: string | null;
  email?: string | null;
  /** users.dealer_id — the dealer CODE. */
  dealer_id?: string | null;
};

/**
 * Canonical dealer type for a dealer CODE, or null when there is no `dealers`
 * row (pre-activation) or the column is unreadable.
 *
 * One indexed lookup on a UNIQUE column. Routes that already hold the dealer
 * code — most dealer-portal APIs resolve one to scope their query — should call
 * this rather than resolveDealerTypeForUser, which would re-derive the code
 * they already have.
 */
export async function resolveDealerTypeByCode(
  dealerCode: string | null | undefined,
): Promise<DealerTypeValue | null> {
  if (!dealerCode) return null;

  try {
    const [row] = await db
      .select({ dealerType: dealers.dealer_type })
      .from(dealers)
      .where(eq(dealers.dealer_id, dealerCode))
      .limit(1);

    return normalizeDealerType(row?.dealerType);
  } catch {
    // An environment without E-202 applied raises "column does not exist".
    // Return null rather than 500ing a whole portal over a classification
    // field — callers default to 'new', which is the pre-E-202 behaviour.
    return null;
  }
}

/**
 * The stored dealer type for this user, or `"new"` when it cannot be
 * determined.
 *
 * Never returns null: every consumer would otherwise have to re-implement the
 * same "unknown means new" fallback that E-202's backfill established, and one
 * of them would get it wrong. A dealer whose row predates E-202 behaves exactly
 * as they do today.
 *
 * Order of preference — cheapest first, because this runs on every guarded
 * buyback API call:
 *  1. `dealers.dealer_type` — canonical, written at approval, one indexed
 *     lookup on a UNIQUE column.
 *  2. `dealer_onboarding_applications.dealer_type` — costs up to three queries,
 *     so it is only reached for a dealer with no `dealer_id` yet (i.e. not
 *     approved), who by definition has no buyback rows to guard.
 */
export async function resolveDealerTypeForUser(
  user: DealerIdentity,
): Promise<DealerTypeValue> {
  if (user.dealer_id) {
    const canonical = await resolveDealerTypeByCode(user.dealer_id);
    if (canonical) return canonical;
  }

  try {
    const application = await findLatestDealerOnboardingApplication({
      authUserId: user.id ?? null,
      profileUserId: user.id ?? null,
      email: user.email ?? null,
    });
    return normalizeDealerType(application?.dealer_type) ?? "new";
  } catch {
    return "new";
  }
}
