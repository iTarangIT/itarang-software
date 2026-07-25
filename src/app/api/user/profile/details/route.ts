import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, scrapVendors } from "@/lib/db/schema";
import { requireAuthWithSupabaseUser } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { findLatestDealerOnboardingApplication } from "@/lib/dealer-onboarding";
import { getCurrentTenant, getCurrentNbfcRole } from "@/lib/nbfc/tenant";
import { NBFC_ROLE_LABELS } from "@/lib/nbfc/origination-roles";
import { log } from "@/lib/log";

/**
 * GET /api/user/profile/details — the ROLE-SPECIFIC half of the profile page.
 *
 * Deliberately separate from /api/user/profile rather than an `extra` block on
 * it. That route is on the critical path of every page (AuthProvider fetches it
 * on every hard navigation and gates the whole tree on `loading`), and its
 * response is written verbatim into sessionStorage. Folding 1-2 role joins into
 * it would make every user pay on every page to serve one page, and would grow
 * the AppUser type that ~200 call sites consume through useAuth().
 *
 * Keeping them apart also keeps /api/user/profile's contract to one verifiable
 * sentence: "the users row, minus password_hash".
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async () => {
  const { dbUser, authUser } = await requireAuthWithSupabaseUser();
  const role = (dbUser.role || "").toLowerCase();

  if (role === "dealer") {
    const app = await findLatestDealerOnboardingApplication({
      authUserId: authUser.id,
      profileUserId: dbUser.id,
      email: authUser.email,
    });

    // users.dealer_id holds an accounts.id — NOT dealers.dealer_id. Joining
    // `dealers` by this column would silently return nothing.
    let account: { city: string | null; state: string | null; gstin: string | null } | null = null;
    if (dbUser.dealer_id) {
      const [row] = await db
        .select({ city: accounts.city, state: accounts.state, gstin: accounts.gstin })
        .from(accounts)
        .where(eq(accounts.id, dbUser.dealer_id))
        .limit(1);
      account = row ?? null;
    }

    if (!app && !account) return successResponse({ kind: "none" as const });

    return successResponse({
      kind: "dealer" as const,
      dealer: {
        // Canonical resolution, same as /api/dealer/stats.
        dealerId: dbUser.dealer_id || app?.dealer_code || null,
        companyName: app?.company_name ?? null,
        companyType: app?.company_type ?? null,
        dealerType: app?.dealer_type ?? null,
        gstNumber: app?.gst_number ?? account?.gstin ?? null,
        panNumber: app?.pan_number ?? null,
        financeEnabled: Boolean(app?.finance_enabled),
        onboardingStatus: app?.onboarding_status ?? null,
        reviewStatus: app?.review_status ?? null,
        city: app?.city ?? account?.city ?? null,
        state: app?.state ?? account?.state ?? null,
        submittedAt: app?.submitted_at ?? null,
        approvedAt: app?.approved_at ?? null,
      },
    });
  }

  if (role === "nbfc_partner") {
    try {
      const tenant = await getCurrentTenant();
      const nbfcRole = await getCurrentNbfcRole(tenant.id);
      return successResponse({
        kind: "nbfc" as const,
        nbfc: {
          tenantId: tenant.id,
          displayName: tenant.display_name,
          contactEmail: tenant.contact_email ?? null,
          // The REAL job title. users.role is always the flat "nbfc_partner".
          nbfcRole: nbfcRole ?? null,
          nbfcRoleLabel: nbfcRole ? (NBFC_ROLE_LABELS[nbfcRole] ?? null) : null,
        },
      });
    } catch (err) {
      // getCurrentTenant throws when an nbfc_partner has no nbfc_users
      // membership. That is a data problem for an admin to fix — it must not
      // 500 the person's own profile page.
      log.warn("[PROFILE-DETAILS] nbfc tenant unresolved", {
        userId: dbUser.id,
        err: err instanceof Error ? err.message : String(err),
      });
      return successResponse({ kind: "none" as const });
    }
  }

  if (role === "scrap_vendor" && dbUser.vendor_entity_id) {
    // Never select credit_limit or any bank field — financial PII, not profile
    // data.
    const [row] = await db
      .select({
        entityId: accounts.id,
        businessName: accounts.business_entity_name,
        gstin: accounts.gstin,
        city: accounts.city,
        state: accounts.state,
        categories: scrapVendors.categories,
        regions: scrapVendors.regions,
        paymentTerms: scrapVendors.payment_terms,
        active: scrapVendors.active,
      })
      .from(accounts)
      .leftJoin(scrapVendors, eq(scrapVendors.entity_id, accounts.id))
      .where(eq(accounts.id, dbUser.vendor_entity_id))
      .limit(1);

    if (!row) return successResponse({ kind: "none" as const });

    return successResponse({
      kind: "vendor" as const,
      vendor: {
        entityId: row.entityId,
        businessName: row.businessName ?? null,
        gstin: row.gstin ?? null,
        city: row.city ?? null,
        state: row.state ?? null,
        categories: Array.isArray(row.categories) ? (row.categories as string[]) : [],
        regions: Array.isArray(row.regions) ? row.regions : [],
        paymentTerms: row.paymentTerms ?? null,
        active: row.active ?? true,
      },
    });
  }

  // Internal staff (admin/ceo/sales_head/…) have no second entity — render no
  // extra card at all rather than an empty "Not available" stub.
  return successResponse({ kind: "none" as const });
});
