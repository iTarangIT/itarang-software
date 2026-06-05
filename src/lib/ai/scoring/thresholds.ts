// THE single source of truth for intent thresholds, lead-status labels, and
// routing. Both the routing decision (push_to_crm / schedule_call / follow_up /
// stop) AND the status label (qualified / warm / cold / disqualified) read these
// same constants — eliminating the historical 80-vs-75 and 50-vs-40 drift.

import type { IntentSignals } from "./signals";

// Aligned set (decided with the team): matches the existing >=75 conversion
// filters already used across SQL/UI.
export const INTENT_THRESHOLDS = {
  QUALIFIED: 75,
  WARM: 45,
  COLD: 20,
} as const;

// Finer VISUAL-ONLY tier for "hot" badges. Never used for routing or status.
export const HOT_BADGE = 85;

export type LeadStatus = "qualified" | "warm" | "cold" | "disqualified";
export type NextAction = "push_to_crm" | "schedule_call" | "follow_up" | "stop";

export interface RouteDecision {
  status: LeadStatus;
  action: NextAction;
}

// Hard gates that override the numeric rank. `qualified_gate === false` means a
// score >= QUALIFIED still cannot be labelled "qualified" (e.g. authority absent).
export interface StatusGates {
  qualified_gate?: boolean;
  do_not_call?: boolean;
  explicit_not_interested?: boolean;
  already_bought_competitor?: boolean;
}

/** Map a canonical score (+ gates) to a status label. */
export function leadStatusFor(score: number, gates: StatusGates = {}): LeadStatus {
  if (gates.do_not_call || gates.explicit_not_interested || gates.already_bought_competitor) {
    return "disqualified";
  }
  if (score >= INTENT_THRESHOLDS.QUALIFIED) {
    return gates.qualified_gate === false ? "warm" : "qualified";
  }
  if (score >= INTENT_THRESHOLDS.WARM) return "warm";
  if (score >= INTENT_THRESHOLDS.COLD) return "cold";
  return "disqualified";
}

type RouteSignals = Pick<IntentSignals, "facts" | "negatives" | "authority">;

/**
 * Map a canonical score + signals to a routing decision. The ONE place business
 * overrides live:
 *   - hard negatives (do-not-call / not-interested / competitor-bought) → stop
 *   - explicit callback request → schedule_call/warm (decoupled from the number;
 *     a brush-off no longer inflates the score, but we still place the callback)
 *   - otherwise the canonical score + gates decide the tier.
 */
export function decideRoute(
  score: number,
  signals?: RouteSignals | null,
  qualifiedGate?: boolean,
): RouteDecision {
  const negs = signals?.negatives;
  if (negs?.do_not_call || negs?.explicit_not_interested || negs?.already_bought_competitor) {
    return { status: "disqualified", action: "stop" };
  }

  if (signals?.facts?.callback_requested) {
    return { status: "warm", action: "schedule_call" };
  }

  const status = leadStatusFor(score, {
    qualified_gate: qualifiedGate,
    do_not_call: negs?.do_not_call,
    explicit_not_interested: negs?.explicit_not_interested,
    already_bought_competitor: negs?.already_bought_competitor,
  });

  switch (status) {
    case "qualified":
      return { status, action: "push_to_crm" };
    case "warm":
      return { status, action: "schedule_call" };
    case "cold":
      return { status, action: "follow_up" };
    default:
      return { status: "disqualified", action: "stop" };
  }
}
