// Part 0 BRD lifecycle engine — pure TypeScript, no DB calls.
// Source of truth for status transitions, hard/soft validation, and the
// list of high-impact Lost reasons that need a confirmation modal.
// BRD refs: §0.7 (Status Lifecycle), §0.10 (Commercials hard validation).

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

export type TransitionCtx = {
  // Engaged touchpoints already on the lead (BRD §0.7: Assigned_Not_Contacted
  // → Under_Discussion requires ≥1 is_engaged = true touchpoint).
  engagedTouchpointCount?: number;
  // Current dealer_lead_commercials row's final_price (BRD §0.10 hard validation).
  finalPrice?: number | null;
  // Whether a commercials row exists at all (for soft warning on Commercials_Explained).
  hasCommercialsRow?: boolean;
  // The reason being recorded with a Lost transition.
  lostReason?: LostReason;
  // Acting user's role — Converted → Lost is admin-only (onboarding-dropout loopback).
  actorRole?: string;
};

export type TransitionResult =
  | { ok: true }
  | { ok: false; severity: Severity; reason: string };

// BRD §0.7 Status Transition Map. Each entry lists every legal target from
// the from-state. Reactivation (Lost → Assigned_Not_Contacted) is handled
// via the unified procedure in BRD §0.9 — modeled here as a legal transition.
export const TRANSITION_MAP: Record<LeadStatus, LeadStatus[]> = {
  New_Unassigned: ["Assigned_Not_Contacted"],
  Assigned_Not_Contacted: ["Under_Discussion", "Lost"],
  Under_Discussion: [
    "Commercials_Explained",
    "Awaiting_Customer_Decision",
    "Transferred_to_ASM",
    "Lost",
  ],
  Commercials_Explained: [
    "Commercials_Finalised",
    "Under_Discussion",
    "Awaiting_Customer_Decision",
    "Transferred_to_ASM",
    "Lost",
  ],
  Commercials_Finalised: ["Transferred_to_ASM", "Converted", "Lost"],
  Awaiting_Customer_Decision: [
    "Under_Discussion",
    "Commercials_Explained",
    "Commercials_Finalised",
    "Lost",
  ],
  Transferred_to_ASM: ["Converted", "Lost"],
  Lost: ["Assigned_Not_Contacted"],
  Converted: ["Lost"],
};

// Targets that the BRD soft-warns on when reached from specific predecessors,
// regardless of whether they're hard-allowed. Returned with severity='soft'.
const SOFT_WARNINGS: Array<{
  from: LeadStatus;
  to: LeadStatus;
  predicate: (ctx: TransitionCtx) => string | null;
}> = [
  {
    from: "Under_Discussion",
    to: "Commercials_Explained",
    predicate: (ctx) =>
      ctx.hasCommercialsRow === false
        ? "You haven't logged commercials yet. Continue anyway?"
        : null,
  },
  {
    from: "Commercials_Explained",
    to: "Commercials_Finalised",
    predicate: (_ctx) => null, // hard-validated below; no extra soft warning
  },
  {
    from: "Under_Discussion",
    to: "Commercials_Finalised",
    predicate: () =>
      "You're skipping the Commercials_Explained step. Confirm?",
  },
];

export function canTransition(
  from: LeadStatus,
  to: LeadStatus,
  ctx: TransitionCtx = {},
): TransitionResult {
  // 1. Target must be a legal successor.
  const legalTargets = TRANSITION_MAP[from];
  if (!legalTargets || !legalTargets.includes(to)) {
    return {
      ok: false,
      severity: "hard",
      reason: `${from} → ${to} is not an allowed transition.`,
    };
  }

  // 2. Mark Lost requires a lost_reason.
  if (to === "Lost" && !ctx.lostReason) {
    return {
      ok: false,
      severity: "hard",
      reason: "Mark Lost requires a lost_reason.",
    };
  }

  // 3. onboarding_dropout is set only via admin loopback (Converted → Lost).
  if (ctx.lostReason === "onboarding_dropout" && ctx.actorRole !== "admin") {
    return {
      ok: false,
      severity: "hard",
      reason:
        "onboarding_dropout is set only via admin onboarding-dropout loopback (BRD §0.11).",
    };
  }

  // 4. Converted → Lost is admin-only.
  if (from === "Converted" && to === "Lost" && ctx.actorRole !== "admin") {
    return {
      ok: false,
      severity: "hard",
      reason:
        "Converted → Lost is admin-only (onboarding-dropout loopback per BRD §0.11).",
    };
  }

  // 5. Assigned_Not_Contacted → Under_Discussion needs ≥1 engaged touchpoint.
  if (
    from === "Assigned_Not_Contacted" &&
    to === "Under_Discussion" &&
    (ctx.engagedTouchpointCount ?? 0) < 1
  ) {
    return {
      ok: false,
      severity: "hard",
      reason:
        "Under_Discussion requires at least one engaged touchpoint (BRD §0.7).",
    };
  }

  // 6. Commercials_Finalised + Converted require final_price on current row.
  if (
    (to === "Commercials_Finalised" || to === "Converted") &&
    (ctx.finalPrice === null || ctx.finalPrice === undefined)
  ) {
    return {
      ok: false,
      severity: "hard",
      reason: `${to} requires final_price on the current commercials row (BRD §0.10).`,
    };
  }

  // 7. Soft warnings — return ok=false with severity='soft' so callers can
  //    show the confirm dialog and re-call with an override flag.
  for (const rule of SOFT_WARNINGS) {
    if (rule.from === from && rule.to === to) {
      const msg = rule.predicate(ctx);
      if (msg) {
        return { ok: false, severity: "soft", reason: msg };
      }
    }
  }

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
