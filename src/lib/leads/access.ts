// Who can reach the merged /leads screen, and what they can do on it.
//
// Client-safe by design: NO db import, so client components can read these
// without pulling postgres/net into the bundle. Same split, and same reason, as
// src/lib/admin/leadsInfoFilters.ts.

/**
 * Roles allowed to load the leads list at all.
 *
 * ⚠ This list is a SECURITY FIX, not bookkeeping. /leads is not in middleware's
 * `sharedRouteAccess`, and it matches no `roleDashboards` prefix, so the
 * "wrong role → bounce to your own dashboard" check never fires for it
 * (src/middleware.ts). Every signed-in user of EVERY role — dealer,
 * nbfc_partner, scrap_vendor, service_engineer — can load /leads today, and
 * GET /api/dealer-leads had no auth check of any kind, so the whole prospect
 * table (names, phones) was readable by anyone signed in. Enforcing this list
 * on the API is what actually closes that.
 *
 * Membership rationale — every role here can already reach the page or a tab on
 * it, so nobody loses access:
 *   admin                                  — gains the sidebar entry in this change
 *   ceo, sales_head, sales_manager,
 *   sales_executive                        — have a /leads sidebar entry today
 *   business_head                          — in NEODOVE_ROLES + COST_ANALYTICS_ROLES
 *   finance_controller                     — in COST_ANALYTICS_ROLES; the Cost
 *                                            Analytics tab lives on this page, so
 *                                            excluding it would strand that tab
 *   sales_insight, inside_sales_rep, asm   — the pipeline this list describes
 */
export const LEADS_PAGE_ROLES = [
  "admin",
  "ceo",
  "business_head",
  "sales_head",
  "sales_manager",
  "sales_executive",
  "sales_insight",
  "inside_sales_rep",
  "asm",
  "finance_controller",
] as const;

/**
 * Roles that may see WHO owns a lead — the Owner and ASM columns, their filter
 * dropdowns, and their facet lists.
 *
 * Kept narrower than LEADS_PAGE_ROLES on purpose. Owner/ASM were previously
 * visible only on /admin/leads-info, which was `["admin","sales_head"]`-gated.
 * Merging the two screens must not silently widen that to every sales role as a
 * side effect of a UI change, so the columns are gated rather than just merged
 * in. Enforced server-side (the fields are nulled and the params ignored), not
 * by hiding a column in CSS.
 */
export const LEADS_OVERSIGHT_ROLES = [
  "admin",
  "sales_head",
  "ceo",
  "business_head",
  "sales_manager",
] as const;

/**
 * Roles that may mutate leads in bulk: Reassign, Mark Lost, Export CSV.
 *
 * ⚠ MUST stay equal to MUTATE_ROLES in src/app/api/admin/leads/bulk/route.ts.
 * This is not a style preference — Export CSV is inside that same requireRole,
 * so showing this bar to a role the API refuses renders three buttons that all
 * 403. The reassign form in the lead drawer posts to the same endpoint.
 */
export const LEADS_BULK_ROLES = ["admin", "sales_head"] as const;

/**
 * Roles that can be handed ownership of a lead — the target list for the
 * reassign pickers.
 *
 * ⚠ This exists because the pickers were quietly limited to two roles.
 * GET /api/admin/users defaults to `["inside_sales_rep","asm"]` when no `roles`
 * param is passed, and every caller omitted it — so a drawer that told the user
 * it could "hand the lead to any user across roles" could only ever list reps
 * and ASMs. Callers must pass this list explicitly.
 *
 * Safe against the reassign endpoint: /api/admin/leads/bulk branches on the
 * TARGET's role — `asm` lifts the lead to Transferred_to_ASM, `inside_sales_rep`
 * promotes New_Unassigned to Assigned_Not_Contacted, and everything else takes
 * the plain owner-swap path. No role here breaks that logic.
 *
 * ⚠ Any caller passing this MUST use a query key distinct from the bare
 * ["admin-user-options"] that the default-list pickers share, or it will poison
 * their 5-minute cache with a wider list (or be poisoned by their narrower one).
 */
export const LEAD_ASSIGNEE_ROLES = [
  "inside_sales_rep",
  "asm",
  "sales_executive",
  "sales_manager",
  "sales_head",
] as const;

export type LeadsCapabilities = {
  canSeeOwnerAsm: boolean;
  canBulkAct: boolean;
  canSendToNeodove: boolean;
  canSeeCostAnalytics: boolean;
};

// Mirrors NEODOVE_ADMIN_ROLES (src/lib/neodove/roles.ts) and the server gate on
// /api/campaigns/cost-analytics. Both were already duplicated as literals inside
// leads/page.tsx; consolidating them here means one place to edit, and the
// server now decides rather than the client guessing.
const NEODOVE_ROLES = [
  "admin",
  "sales_head",
  "business_head",
  "ceo",
  "sales_manager",
];
const COST_ANALYTICS_ROLES = [
  "ceo",
  "business_head",
  "sales_head",
  "finance_controller",
  "admin",
];

export function capabilitiesFor(role: string | null | undefined): LeadsCapabilities {
  const r = role ?? "";
  return {
    canSeeOwnerAsm: (LEADS_OVERSIGHT_ROLES as readonly string[]).includes(r),
    canBulkAct: (LEADS_BULK_ROLES as readonly string[]).includes(r),
    canSendToNeodove: NEODOVE_ROLES.includes(r),
    canSeeCostAnalytics: COST_ANALYTICS_ROLES.includes(r),
  };
}

/** Everything false — the safe default before the profile/capabilities load. */
export const NO_CAPABILITIES: LeadsCapabilities = {
  canSeeOwnerAsm: false,
  canBulkAct: false,
  canSendToNeodove: false,
  canSeeCostAnalytics: false,
};
