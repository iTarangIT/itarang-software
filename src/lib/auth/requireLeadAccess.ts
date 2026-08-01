import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { leads } from "@/lib/db/schema";
import { getAuthenticatedAppUser } from "@/lib/kyc/admin-workflow";

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
 *      leads.dealer_id equals their users.dealer_id (dealer CODE); back-office
 *      roles pass through.
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
    .select({ dealer_id: leads.dealer_id })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);

  if (!lead || !user.dealer_id || lead.dealer_id !== user.dealer_id) {
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, error: { message: "Forbidden" } },
        { status: 403 }
      ),
    };
  }

  return { ok: true, user: { id: user.id, role: user.role, dealer_id: user.dealer_id } };
}
