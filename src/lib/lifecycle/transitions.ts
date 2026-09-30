// Part 0 BRD lifecycle engine — pure TypeScript, no DB calls.
// Source of truth for the status vocabulary and the list of high-impact Lost
// reasons that need a confirmation modal.
//
// Transition validation is back (S3, 29 Sep 2026): see statusRules.ts.
// BRD refs: §0.7 (Status Lifecycle), §0.10 (Commercials).

import { checkStatusMove } from "@/lib/lifecycle/statusRules";

export const LEAD_STATUS = [
  "New_Unassigned",
  "Assigned_Not_Contacted",
  "Under_Discussion",
  "Commercials_Explained",
  "Commercials_Finalised",
  "Awaiting_Customer_Decision",
  "Transferred_to_ASM",
  // ID 74 (29 Sep 2026): the rep's Mark Won. Converted is set only when the
  // admin approves the dealer's onboarding — credit and targets run on it.
  "Won",
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
  // Won is still open: the dealer is onboarding. It leaves the funnel only as
  // Converted (onboarding approved) or Lost (dropped out).
  "Won",
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
  // ID 76 (29 Sep 2026). lost_to_competition carries the competitor's name
  // (dealer_leads.competitor_name, E-314).
  "lost_to_competition",
  "moved_to_other_business",
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

// S3 (tracker ID 115, 29 Sep 2026): the permissive map of 2026-08-18 is gone.
// Status moves forward only and only on its event; the rules live in
// statusRules.ts and writeTouchpoint enforces them for every entry point.
//
// TRANSITION_MAP is what a rep's own action can reach from each status — the UI
// reads it to build the "Update lead status" menu (LeadStatusEditor): forward
// open stages, plus Transfer / Converted / Lost through their dedicated flows.
// A closed lead offers nothing; reopening is reactivation or admin "Correct status".
export const TRANSITION_MAP: Record<LeadStatus, LeadStatus[]> = Object.fromEntries(
  LEAD_STATUS.map((from) => [
    from,
    LEAD_STATUS.filter((to) => {
      if (to === "Transferred_to_ASM") return checkStatusMove({ from, to, event: "transfer" }).ok;
      if (to === "Won") return checkStatusMove({ from, to, event: "mark_won" }).ok;
      if (to === "Converted") return false; // onboarding approval only, never a rep's menu
      if (to === "Lost") return checkStatusMove({ from, to, event: "mark_lost" }).ok;
      return checkStatusMove({ from, to, event: "progress" }).ok;
    }),
  ]),
) as Record<LeadStatus, LeadStatus[]>;

// An ordinary (progress) move under the S3 rules. TransitionCtx is still
// accepted so the call sites stay untouched; nothing reads it.
export function canTransition(
  from: LeadStatus,
  to: LeadStatus,
  ctx: TransitionCtx = {},
): TransitionResult {
  void ctx;
  const verdict = checkStatusMove({ from, to, event: "progress" });
  return verdict.ok ? { ok: true } : { ok: false, severity: "hard", reason: verdict.reason };
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
