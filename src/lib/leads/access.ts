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
 *   partner                                — Chirag's login: sales_head-level lead
 *                                            scope by decision (2026-09-10)
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
  "partner",
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
  "partner",
] as const;

/**
 * May this user change or delete THIS saved region group (tracker ID 118)?
 *
 * Groups are org-wide: every /leads role can list them and save a new one. But
 * one rep could rename or delete a group every dialer campaign relies on, so
 * edit and delete are for the oversight roles and for whoever created the
 * group. A group with no recorded creator (the seeds, and anything saved before
 * created_by was taken from the session) is oversight-only.
 */
export function canEditRegionGroup(input: {
  role: string | null | undefined;
  userId: string | null | undefined;
  createdBy: string | null | undefined;
}): boolean {
  if ((LEADS_OVERSIGHT_ROLES as readonly string[]).includes(input.role ?? "")) return true;
  return Boolean(input.userId) && input.createdBy === input.userId;
}

/**
 * May this user open the Edit Lead form for THIS lead and save it (tracker
 * ID 132)?
 *
 * The form changes who the dealer is and how to reach them — name, phone,
 * location. Until 5 Oct any /leads role could do that to any lead, so a rep
 * could change the phone number of a dealer another rep was working. Now:
 * the oversight roles may edit any lead; everyone else only a lead they
 * currently own, or are the assigned ASM of.
 *
 * ⚠ This IS the rule PATCH /api/dealer-leads/[id] and /leads/[id]/edit
 * enforce, and the one the list uses to show the Edit link, so the link never
 * leads to a refusal.
 */
export function canEditLead(input: {
  role: string | null | undefined;
  userId: string | null | undefined;
  currentOwnerId: string | null | undefined;
  asmId: string | null | undefined;
}): boolean {
  const role = input.role ?? "";
  if (!(LEADS_PAGE_ROLES as readonly string[]).includes(role)) return false;
  if ((LEADS_OVERSIGHT_ROLES as readonly string[]).includes(role)) return true;
  if (!input.userId) return false;
  return input.currentOwnerId === input.userId || input.asmId === input.userId;
}

/**
 * Roles that may mutate leads in bulk: Reassign, Mark Lost, Export CSV.
 *
 * ⚠ MUST stay equal to MUTATE_ROLES in src/app/api/admin/leads/bulk/route.ts.
 * This is not a style preference — Export CSV is inside that same requireRole,
 * so showing this bar to a role the API refuses renders three buttons that all
 * 403. The reassign form in the lead drawer posts to the same endpoint.
 */
export const LEADS_BULK_ROLES = ["admin", "sales_head", "ceo", "partner"] as const;

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
  "partner",
] as const;

/**
 * Roles whose lead exports are limited to the leads they OWN (tracker ID 58,
 * decision 26 Sep 2026) — queue sheets, the /leads export, the AI-dialer
 * campaign sheet and a single lead's history. Everyone else in an export's
 * role list is a manager and exports what they can see.
 */
export const OWN_LEADS_EXPORT_ROLES = ["asm", "inside_sales_rep", "partner"] as const;

export function exportsOwnLeadsOnly(role: string | null | undefined): boolean {
  return (OWN_LEADS_EXPORT_ROLES as readonly string[]).includes((role ?? "").toLowerCase());
}

/**
 * Roles that may READ only the leads they own (dealer_leads.current_owner_id)
 * — lead detail / edit pages, call logs, recordings, AI summaries (tracker ID
 * 45). Anything else is a 404 "Lead not found", same as no such lead.
 *
 * partner is deliberately NOT here (unlike OWN_LEADS_EXPORT_ROLES): its read
 * scope is open business question Q3, so it keeps today's access until decided.
 */
export const OWN_LEADS_READ_ROLES = ["asm", "inside_sales_rep"] as const;

export function readsOwnLeadsOnly(role: string | null | undefined): boolean {
  return (OWN_LEADS_READ_ROLES as readonly string[]).includes((role ?? "").toLowerCase());
}

/**
 * May this user download THIS lead's history workbook? The role must be in
 * LEAD_HISTORY_EXPORT_ROLES, and a rep / ASM / partner must also be the lead's
 * current owner (ID 58). One rule for the export route and for both screens
 * that show the button, so a visible button never 403s.
 */
export function canExportLeadHistory(input: {
  role: string | null | undefined;
  userId: string | null | undefined;
  currentOwnerId: string | null | undefined;
}): boolean {
  const role = input.role ?? "";
  if (!(LEAD_HISTORY_EXPORT_ROLES as readonly string[]).includes(role)) return false;
  if (!exportsOwnLeadsOnly(role)) return true;
  return Boolean(input.userId) && input.currentOwnerId === input.userId;
}

/**
 * Roles that may open a lead's TRACKING view — the journey (who held it, for
 * how long, what they did) — and download it as CSV (E-295).
 *
 * ⚠ This IS the list GET /api/dealer-leads/[id]/tracking enforces, so the
 * "Lead tracking" section and the endpoint cannot drift apart.
 *
 * Two tiers inside it:
 *   admin, ceo, sales_head        — any lead.
 *   inside_sales_rep, asm         — only leads they have handled, see
 *                                   LEAD_TRACKING_OWN_ONLY_ROLES.
 * The bulk "Lead Tracking CSV" (many leads, one file) rides on
 * LEADS_BULK_ROLES instead — same bar, same endpoint gate as Export CSV.
 *
 * business_head / sales_manager are deliberately not here: the request named
 * these five roles, and widening who can pull a lead's whole hand-off history
 * is a team decision, not a side effect.
 */
export const LEAD_TRACKING_ROLES = [
  "admin",
  "ceo",
  "sales_head",
  "inside_sales_rep",
  "asm",
  "partner",
] as const;

/**
 * Roles whose tracking access is scoped to leads THEY have handled: current
 * owner, ASM, originator, or the recipient of any recorded hand-off
 * (lead_touchpoints.to_owner_id, or a lead_claimed they performed). Enforced
 * server-side in canViewLeadTracking() — src/lib/leads/tracking.ts.
 */
/**
 * Roles that may open the lead working page (/inside-sales/lead/[id]) — status,
 * Change Lost reason, Undo Mark Won, Withdraw quote, the full history. Must match the
 * "/inside-sales/lead" row of sharedRouteAccess in src/middleware.ts; a role
 * missing there would get a button to a page that bounces it.
 */
export const LEAD_WORKSPACE_ROLES = [
  "inside_sales_rep",
  "asm",
  "admin",
  "ceo",
  "sales_manager",
  "sales_head",
  "business_head",
  "partner",
] as const;

export const LEAD_TRACKING_OWN_ONLY_ROLES = ["inside_sales_rep", "asm"] as const;

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
  "partner",
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
  "partner",
] as const;

/**
 * Roles that may promote a correction into the extraction prompt — the
 * /admin/ai-intent console.
 *
 * Kept to the oversight roles on purpose (plus `partner`, which reaches
 * /admin/ai-intent through its own sharedRouteAccess row in middleware). A promoted example is a
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
export const INTENT_CURATOR_ROLES = ["admin", "ceo", "sales_head", "partner"] as const;

/**
 * Roles that may DRIVE an AI-dialer campaign from its detail screen — Call next,
 * Force stop, Resume calling, Retry unreached. Enforced by the matching
 * /api/ai-dialer/campaigns/[id]/{advance,stop,resume,recall-failed} routes; the
 * detail view only hides the buttons.
 *
 * asm and inside_sales_rep are deliberately ABSENT: they can open their own
 * campaigns read-only, but placing or re-placing calls is an oversight action.
 * `partner` keeps the stop/resume/retry it always had (those routes had no role
 * check before).
 */
export const CAMPAIGN_ACTION_ROLES = [
  "admin",
  "ceo",
  "business_head",
  "sales_head",
  "sales_manager",
  "partner",
] as const;

/**
 * Roles that may download a campaign's Excel export
 * (/api/ai-dialer/campaigns/[id]/export.xlsx). asm and inside_sales_rep are
 * excluded for the same reason as CAMPAIGN_ACTION_ROLES.
 */
export const CAMPAIGN_EXPORT_ROLES = [
  "ceo",
  "business_head",
  "sales_head",
  "sales_manager",
  "sales_executive",
  "admin",
] as const;

export function canRunCampaignActions(role: string | null | undefined): boolean {
  return (CAMPAIGN_ACTION_ROLES as readonly string[]).includes(role ?? "");
}

export function canExportCampaign(role: string | null | undefined): boolean {
  return (CAMPAIGN_EXPORT_ROLES as readonly string[]).includes(role ?? "");
}

/**
 * ID 118 (decision 10 Oct): roles that may upload an AI-dialer calling list,
 * start a dialer run (list or region) and stop the running one. These place
 * real, billable calls and add leads, so the set is narrower than
 * LEADS_OVERSIGHT_ROLES. Enforced on /api/ai-dialer/{start,stop,lists/create,
 * lists/[id]/start}; a logged-out call is 401, any other role 403.
 */
export const DIALER_CONTROL_ROLES = ["admin", "ceo", "sales_head"] as const;

export function canControlDialer(role: string | null | undefined): boolean {
  return (DIALER_CONTROL_ROLES as readonly string[]).includes(role ?? "");
}

export type LeadsCapabilities = {
  canSeeOwnerAsm: boolean;
  canBulkAct: boolean;
  canSendToNeodove: boolean;
  canSeeCostAnalytics: boolean;
  /** ID 144 — the AI dialer weekday × hour answer grid (CALL_TIMING_ROLES). */
  canSeeCallTiming: boolean;
  canReviewIntent: boolean;
  canCurateIntent: boolean;
  /** May open the "Lead tracking" section and download a single lead's CSV. */
  canTrackLeads: boolean;
  /** May open the lead working page (LEAD_WORKSPACE_ROLES). */
  canOpenLeadPage: boolean;
  /**
   * May "Change Lost reason" on a Lost lead — /api/admin/leads/[id]/lost-reason
   * (ID 136). "Correct status" is gone: nobody picks a status by hand.
   */
  canChangeLostReason: boolean;
};

/** The roles /api/admin/leads/[id]/lost-reason accepts (ID 136) — LOST_REASON_CHANGE_ROLES. */
const LOST_REASON_ROLES = ["admin", "sales_head"];

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
  "partner",
];
const COST_ANALYTICS_ROLES = [
  "ceo",
  "business_head",
  "sales_head",
  "finance_controller",
  "admin",
  "partner",
];

/**
 * ID 144 — who sees when dealers answer the AI dialer (by weekday and hour),
 * and may set the default calling hours from it. Server gate on
 * /api/campaigns/call-timing reads the same list.
 */
export const CALL_TIMING_ROLES = ["admin", "ceo", "sales_head"] as const;

export function capabilitiesFor(role: string | null | undefined): LeadsCapabilities {
  const r = role ?? "";
  return {
    canSeeOwnerAsm: (LEADS_OVERSIGHT_ROLES as readonly string[]).includes(r),
    canBulkAct: (LEADS_BULK_ROLES as readonly string[]).includes(r),
    canSendToNeodove: NEODOVE_ROLES.includes(r),
    canSeeCostAnalytics: COST_ANALYTICS_ROLES.includes(r),
    canSeeCallTiming: (CALL_TIMING_ROLES as readonly string[]).includes(r),
    canReviewIntent: (INTENT_REVIEW_ROLES as readonly string[]).includes(r),
    canCurateIntent: (INTENT_CURATOR_ROLES as readonly string[]).includes(r),
    canTrackLeads: (LEAD_TRACKING_ROLES as readonly string[]).includes(r),
    canOpenLeadPage: (LEAD_WORKSPACE_ROLES as readonly string[]).includes(r),
    canChangeLostReason: LOST_REASON_ROLES.includes(r),
  };
}

/** Everything false — the safe default before the profile/capabilities load. */
export const NO_CAPABILITIES: LeadsCapabilities = {
  canSeeOwnerAsm: false,
  canBulkAct: false,
  canSendToNeodove: false,
  canSeeCostAnalytics: false,
  canSeeCallTiming: false,
  canReviewIntent: false,
  canCurateIntent: false,
  canTrackLeads: false,
  canOpenLeadPage: false,
  canChangeLostReason: false,
};
