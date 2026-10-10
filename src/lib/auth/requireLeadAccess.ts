import { NextResponse } from "next/server";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { dealerOnboardingApplications, leads } from "@/lib/db/schema";
import { getAuthenticatedAppUser } from "@/lib/kyc/admin-workflow";
import { dealerOwnsLead } from "@/lib/auth/leadAccessRules";

// Back-office roles may read/write any lead's data (review, verification,
// sanction). Mirrors ADMIN_ROLES in src/lib/kyc/admin-workflow.ts, plus
// finance_controller who works loan files across dealers.
const BACK_OFFICE_ROLES = new Set([
  "admin",
  "ceo",
  "business_head",
  "sales_head",
  "sales_manager",
  "sales_executive",
  "finance_controller",
]);

export type LeadAccessResult =
  | { ok: true; user: { id: string; role: string; dealer_id: string | null } }
  | { ok: false; response: NextResponse };

/**
 * Gate an ID-scoped lead route. Middleware treats /api/* as public
 * (src/middleware.ts), so every lead-scoped handler must call this itself.
 * Enforces two things:
 *   1. an authenticated session (else 401), and
 *   2. that the caller owns this lead — a dealer may only touch leads whose
 *      leads.dealer_id equals their users.dealer_id (dealer CODE) — or, for a
 *      dealer login with no users.dealer_id, the dealer_code on their approved
 *      onboarding application (ID 119); back-office roles pass through.
 * This closes the IDOR the security scanner flagged on
 * /api/coborrower/[leadId] (anonymous read of a co-borrower record by id).
 * The 403 is intentionally identical for "lead not found" and "not yours" so
 * the endpoint can't be used to probe which ids exist.
 */
export async function requireLeadAccess(leadId: string): Promise<LeadAccessResult> {
  const user = await getAuthenticatedAppUser();
  if (!user) {
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, error: { message: "Unauthorized" } },
        { status: 401 }
      ),
    };
  }

  if (BACK_OFFICE_ROLES.has(user.role)) {
    return { ok: true, user: { id: user.id, role: user.role, dealer_id: user.dealer_id } };
  }

  // Dealer (or any other non-back-office role): must own the lead.
  const [lead] = await db
    .select({ dealer_id: leads.dealer_id, uploader_id: leads.uploader_id })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);

  // ID 119: a dealer login whose users.dealer_id was never filled in was
  // refused on its OWN leads. Fall back to the dealer code on its onboarding
  // application — the same `users.dealer_id || application.dealer_code`
  // resolution /api/dealer/stats and /api/user/profile/details use — but only
  // for the dealer role, and only via dealer_user_id (never the email match,
  // which can pick up someone else's draft).
  const dealerCode =
    user.dealer_id ||
    (user.role === "dealer" && lead ? await dealerCodeFromApplication(user.id) : null);

  // ID 33: a lead the iTarang House login pushed to another dealer keeps
  // uploader_id = the person who created it, so they can still finish its KYC.
  const isUploader = !!lead && lead.uploader_id === user.id;

  if (!lead || (!isUploader && !dealerOwnsLead(lead.dealer_id, dealerCode))) {
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, error: { message: "Forbidden" } },
        { status: 403 }
      ),
    };
  }

  return { ok: true, user: { id: user.id, role: user.role, dealer_id: dealerCode } };
}

/** Dealer code on the latest onboarding application this user owns, or null. */
async function dealerCodeFromApplication(userId: string): Promise<string | null> {
  try {
    const [app] = await db
      .select({ dealer_code: dealerOnboardingApplications.dealer_code })
      .from(dealerOnboardingApplications)
      .where(
        and(
          eq(dealerOnboardingApplications.dealer_user_id, userId),
          isNotNull(dealerOnboardingApplications.dealer_code),
        ),
      )
      .orderBy(desc(dealerOnboardingApplications.updated_at))
      .limit(1);
    return app?.dealer_code?.trim() || null;
  } catch (err) {
    console.error("[requireLeadAccess] dealer code fallback failed:", err);
    return null;
  }
}
