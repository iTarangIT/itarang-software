import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { createClient } from "@/lib/supabase/server";
import { db } from "@/lib/db";
import { accountOwnership, dealerOnboardingApplications, users } from "@/lib/db/schema";
import {
  dealerValidationScope,
  mayReadDealerApplication,
  type DealerValidationScope,
} from "@/lib/auth/dealerValidationRules";

// Middleware treats /api/* as public (src/middleware.ts), so each API handler
// must gate itself. Use this helper at the top of every route under
// /api/admin/dealer-verifications/** so approve/reject/PATCH/agreement flows
// are restricted to sales_head only (product decision — dealer onboarding
// review is owned solely by sales_head, not the broader admin-capable set).
//
// ID 166 item 11 (18 Oct): READING the page is wider — Admin and the owner of
// the dealer account too (requireDealerValidationReader below). The actions
// keep this gate.

// CEO is granted the same dealer-validation access as sales_head — the page
// itself is open to both in middleware.ts, so the API must agree or the CEO
// sees an empty queue (403 swallowed by the page).
const SALES_HEAD_ROLES = new Set(["sales_head", "ceo"]);

type SalesHeadUser = {
  id: string;
  email: string | null;
  role: string;
};

export type RequireSalesHeadResult =
  | { ok: true; user: SalesHeadUser }
  | { ok: false; response: NextResponse };

const forbidden = () => ({
  ok: false as const,
  response: NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 }),
});

/**
 * The signed-in, active app user, or a ready 401/403 response.
 */
async function activeAppUser(): Promise<RequireSalesHeadResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, message: "Unauthorized" },
        { status: 401 }
      ),
    };
  }

  // Try to match by Supabase auth user.id first. For users provisioned directly
  // in the app DB (seed users, users created before Supabase sync was in place),
  // the auth user.id will not match the app users.id column — fall back to an
  // email lookup so they still resolve. This mirrors getAuthenticatedAppUser()
  // in src/lib/kyc/admin-workflow.ts and the middleware's profileByEmail branch.
  const selectCols = {
    id: users.id,
    email: users.email,
    role: users.role,
    is_active: users.is_active,
  };

  let [row] = await db
    .select(selectCols)
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);

  if (!row && user.email) {
    [row] = await db
      .select(selectCols)
      .from(users)
      .where(eq(users.email, user.email))
      .limit(1);
  }

  // Reject deactivated users — is_active can be flipped to revoke access
  // without also stripping the role.
  if (!row || !row.is_active) return forbidden();

  return { ok: true, user: { id: row.id, email: row.email, role: row.role } };
}

/**
 * Ensure the caller has an active session and the sales_head role.
 * Returns either the authenticated user or a ready-to-return NextResponse with
 * the appropriate 401/403 status.
 */
export async function requireSalesHead(): Promise<RequireSalesHeadResult> {
  const auth = await activeAppUser();
  if (!auth.ok) return auth;
  if (!SALES_HEAD_ROLES.has(auth.user.role)) return forbidden();
  return auth;
}

export type RequireDealerValidationReaderResult =
  | { ok: true; user: SalesHeadUser; scope: Exclude<DealerValidationScope, "none"> }
  | { ok: false; response: NextResponse };

/**
 * ID 166 item 11: may the caller READ the Dealer Validation page?
 *   - with an application id: Sales Head, CEO, Admin, or the owner of that
 *     dealer application (dealerValidationRules.ts ownsDealerApplication);
 *   - without one (the queue): Sales Head, CEO and Admin get scope "all"; an
 *     owner role gets scope "own" and the caller must filter to its own
 *     applications (ownedApplicationsWhere). Pass { allOnly: true } for the
 *     summary / export, which have no per-owner form.
 * Someone else's application reads as 404, not 403.
 */
export async function requireDealerValidationReader(
  applicationId?: string,
  opts: { allOnly?: boolean } = {},
): Promise<RequireDealerValidationReaderResult> {
  const auth = await activeAppUser();
  if (!auth.ok) return auth;
  const scope = dealerValidationScope(auth.user.role);
  if (scope === "none") return forbidden();
  if (scope === "all") return { ok: true, user: auth.user, scope };
  if (opts.allOnly) return forbidden();
  if (!applicationId) return { ok: true, user: auth.user, scope };

  const [app] = await db
    .select({
      salesperson_user_id: dealerOnboardingApplications.salesperson_user_id,
      owner_id: dealerOnboardingApplications.owner_id,
    })
    .from(dealerOnboardingApplications)
    .where(eq(dealerOnboardingApplications.id, applicationId))
    .limit(1);
  const [own] = app
    ? await db
        .select({ owner: accountOwnership.owner_user_id })
        .from(accountOwnership)
        .where(eq(accountOwnership.source_application_id, applicationId))
        .limit(1)
    : [];
  const allowed =
    !!app &&
    mayReadDealerApplication({
      role: auth.user.role,
      userId: auth.user.id,
      accountOwnerId: own?.owner ?? null,
      salespersonUserId: app.salesperson_user_id,
      ownerId: app.owner_id,
    });
  if (!allowed) {
    return {
      ok: false,
      response: NextResponse.json({ success: false, message: "Application not found" }, { status: 404 }),
    };
  }
  return { ok: true, user: auth.user, scope };
}
