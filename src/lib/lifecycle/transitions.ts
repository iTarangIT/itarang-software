// Part 0 BRD lifecycle engine — pure TypeScript, no DB calls.
// Source of truth for the status vocabulary and the list of high-impact Lost
// reasons that need a confirmation modal.
//
// Transition VALIDATION was removed (2026-08-18): Inside Sales and ASM reps set
// whatever status the conversation actually reached. See canTransition.
// BRD refs: §0.7 (Status Lifecycle), §0.10 (Commercials).

export const LEAD_STATUS = [
  "New_Unassigned",
  "Assigned_Not_Contacted",
  "Under_Discussion",
  "Commercials_Explained",
  "Commercials_Finalised",
  "Awaiting_Customer_Decision",
  "Transferred_to_ASM",
  "Converted",
  "Lost",
] as const;
export type LeadStatus = (typeof LEAD_STATUS)[number];

export const OPEN_STATUSES: LeadStatus[] = [
  "New_Unassigned",
  "Assigned_Not_Contacted",
  "Under_Discussion",
  "Commercials_Explained",
  "Commercials_Finalised",
  "Awaiting_Customer_Decision",
  "Transferred_to_ASM",
];

export const TERMINAL_STATUSES: LeadStatus[] = ["Converted", "Lost"];

export const LOST_REASON = [
  "not_interested",
  "price_high",
  "bad_experience_with_trontek",
  "loan_procedure_issue",
  "business_closed",
  "non_operational_location",
  "rejected_by_us_credit",
  "rejected_by_us_geography",
  "duplicate_lead",
  "other",
  "onboarding_dropout",
] as const;
export type LostReason = (typeof LOST_REASON)[number];

// Trigger a confirmation modal explaining the consequence before close.
export const HIGH_IMPACT_LOST_REASONS = [
  "business_closed",
  "duplicate_lead",
  "rejected_by_us_credit",
  "rejected_by_us_geography",
] as const satisfies readonly LostReason[];

export type Severity = "hard" | "soft";

// Context the callers still gather and pass. Nothing reads it any more — the
// fields are kept so the call sites stay untouched, and reinstating a rule means
// reading a field here again, nowhere else.
export type TransitionCtx = {
  // Engaged touchpoints on the lead, including the one being written.
  engagedTouchpointCount?: number;
  // Current dealer_lead_commercials row's final_price.
  finalPrice?: number | null;
  // Whether a commercials row exists at all.
  hasCommercialsRow?: boolean;
  // The reason being recorded with a Lost transition.
  lostReason?: LostReason;
  // Acting user's role.
  actorRole?: string;
};

export type TransitionResult =
  | { ok: true }
  | { ok: false; severity: Severity; reason: string };

// The transition map is now PERMISSIVE: every status is reachable from every
// other one. Product decision (2026-08-18) — reps kept hitting "X → Y is not an
// allowed transition" on moves the conversation had genuinely made
// (Transferred_to_ASM → Under_Discussion after a visit reopened the deal,
// Under_Discussion → Commercials_Explained before the commercials were typed
// up), with no way forward. The team owns the funnel; what the reporting reads
// is the audit trail — a dealer_lead_status_history row plus a touchpoint per
// change — and that is unchanged.
//
// Still a map, and still excluding self-transitions, because the UI reads it to
// build the "Update lead status" menu (LeadStatusEditor). To reinstate a
// restricted funnel, put the per-status lists back here and read TransitionCtx
// in canTransition again; every caller still handles a hard-failure verdict.
export const TRANSITION_MAP: Record<LeadStatus, LeadStatus[]> = Object.fromEntries(
  LEAD_STATUS.map((from) => [from, LEAD_STATUS.filter((to) => to !== from)]),
) as Record<LeadStatus, LeadStatus[]>;

// Every transition is allowed, for every actor, with no preconditions: no
// transition map, no engaged-touchpoint gate, no final_price gate, no admin-only
// reopen, no soft warnings. Signature and return type are deliberately unchanged
// so the call sites keep compiling and re-tightening is a one-file change.
export function canTransition(
  _from: LeadStatus,
  _to: LeadStatus,
  ctx: TransitionCtx = {},
): TransitionResult {
  void ctx;
  return { ok: true };
}

export function isHighImpactLostReason(r: LostReason): boolean {
  return (HIGH_IMPACT_LOST_REASONS as readonly string[]).includes(r);
}

export function isTerminal(s: LeadStatus): boolean {
  return TERMINAL_STATUSES.includes(s);
}

export function isOpen(s: LeadStatus): boolean {
  return OPEN_STATUSES.includes(s);
}
