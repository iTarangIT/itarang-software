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
export const LEADS_BULK_ROLES = ["admin", "sales_head", "ceo"] as const;

/**
 * Roles that may download a single lead's touchpoint history as .xlsx — the
 * "Export to Excel" button on the inside-sales pane and on the CRM lead-detail
 * Activity timeline.
 *
 * ⚠ This IS the list the export route enforces
 * (src/app/api/inside-sales/lead/[id]/history/export.xlsx/route.ts imports it),
 * so the button and the endpoint cannot drift into a button that 403s.
 *
 * Deliberately NARROWER than LEADS_PAGE_ROLES: sales_executive, sales_insight
 * and finance_controller can read the leads list, but the route has never let
 * them pull a lead's whole activity log into a file, and widening who can walk
 * off with that is a decision for the team, not a side effect of adding a
 * button.
 */
export const LEAD_HISTORY_EXPORT_ROLES = [
  "inside_sales_rep",
  "asm",
  "admin",
  "ceo",
  "sales_manager",
  "sales_head",
  "business_head",
] as const;

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

/**
 * Roles that may REVIEW an AI call and OVERRIDE its intent band — open the
 * transcript, play or attach a recording, and correct Qualified/Warm/Cold/
 * Disqualified.
 *
 * ⚠ This list is the ONLY gate on the override. Correcting a band now writes
 * through to dealer_leads.intent_band and final_intent_score, so it moves the
 * lead in every queue, filter and dashboard — it is a mutation, not a comment.
 * Before E-250 the feedback route had NO role check on POST and no auth check
 * at all on GET, and middleware early-exits on every /api path
 * (src/middleware.ts), so any signed-in user of any role could write to it.
 * Enforcing this list on both handlers is what actually closes that.
 *
 * Membership rationale:
 *   admin, ceo, sales_head, asm  — the reviewers this was built for; each
 *                                  already reaches the lead-detail screen where
 *                                  the panel lives
 *   inside_sales_rep             — THE "sales insight" persona. Note the trap:
 *                                  a separate `sales_insight` role also exists
 *                                  (middleware roleDashboards, its own
 *                                  /sales-insight dashboard), but it is held by
 *                                  NO user on either database — the people the
 *                                  team calls "sales insight" sign in as
 *                                  inside_sales_rep. Reading the role name
 *                                  literally gates the feature to nobody.
 *
 * Deliberately NARROWER than LEADS_PAGE_ROLES: business_head, sales_manager,
 * sales_executive and finance_controller can read the leads list but have no
 * reason to retrain the scoring model.
 */
export const INTENT_REVIEW_ROLES = [
  "admin",
  "ceo",
  "sales_head",
  "asm",
  "inside_sales_rep",
] as const;

/**
 * Roles that may promote a correction into the extraction prompt — the
 * /admin/ai-intent console.
 *
 * Kept to the three oversight roles on purpose. A promoted example is a
 * few-shot the LLM reads on EVERY subsequent call, so one careless promotion
 * degrades scoring for the whole pipeline. That is the entire reason the
 * learning loop is curated rather than automatic: everyone in
 * INTENT_REVIEW_ROLES can teach by correcting, but only these three decide
 * which corrections become instructions.
 *
 * ⚠ Must stay a subset of the roles middleware admits to "/admin"
 * (sharedRouteAccess: admin, sales_head, ceo). Adding a role here that
 * middleware bounces would render a console the user can never reach.
 */
export const INTENT_CURATOR_ROLES = ["admin", "ceo", "sales_head"] as const;

export type LeadsCapabilities = {
  canSeeOwnerAsm: boolean;
  canBulkAct: boolean;
  canSendToNeodove: boolean;
  canSeeCostAnalytics: boolean;
  canReviewIntent: boolean;
  canCurateIntent: boolean;
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
    canReviewIntent: (INTENT_REVIEW_ROLES as readonly string[]).includes(r),
    canCurateIntent: (INTENT_CURATOR_ROLES as readonly string[]).includes(r),
  };
}

/** Everything false — the safe default before the profile/capabilities load. */
export const NO_CAPABILITIES: LeadsCapabilities = {
  canSeeOwnerAsm: false,
  canBulkAct: false,
  canSendToNeodove: false,
  canSeeCostAnalytics: false,
  canReviewIntent: false,
  canCurateIntent: false,
};
