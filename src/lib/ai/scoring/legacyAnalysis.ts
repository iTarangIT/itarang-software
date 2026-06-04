// Back-compat bridges. The new engine produces signals + a truthful
// score_breakdown, but a lot of stored data and secondary UI still expect the
// legacy 6-field `analysis` object (0..10 bars), a coarse `outcome` label, and a
// `memory` blob. These derive those shapes from the new signals so old rows and
// untouched components keep rendering. The new drawer renders score_breakdown
// directly; these are the fallback.

import type { IntentSignals } from "./signals";
import { LEVEL_FRACTION, TIMELINE_FRACTION, OBJECTION_FRACTION } from "./weights";

export type LegacyOutcome =
  | "interested"
  | "not_interested"
  | "callback_requested"
  | "unknown";

// The historical 6-dimension analysis the existing UI bars read (each 0..10),
// plus the canonical intent_score.
export interface LegacySubScores {
  next_step_commitment: number;
  urgency_signals: number;
  product_curiosity: number;
  need_acknowledgment: number;
  objection_quality: number;
  engagement_depth: number;
  intent_score: number;
}

export interface LegacyMemory {
  requirement: string | null;
  product_interest: string | null;
  quantity: string | null;
  intent_summary: string;
  followup_reason: string | null;
}

const to10 = (frac: number) => Math.round(10 * frac);

/** Derive the legacy 0..10 bars from new signals (for the fallback UI). */
export function toLegacySubScores(
  signals: IntentSignals,
  intentScore: number,
): LegacySubScores {
  return {
    next_step_commitment: to10(LEVEL_FRACTION[signals.budget.level]),
    urgency_signals: to10(TIMELINE_FRACTION[signals.timeline.level]),
    product_curiosity: to10(LEVEL_FRACTION[signals.curiosity.level]),
    need_acknowledgment: to10(LEVEL_FRACTION[signals.need.level]),
    objection_quality: to10(OBJECTION_FRACTION[signals.objection_quality.level]),
    engagement_depth: to10(LEVEL_FRACTION[signals.engagement.level]),
    intent_score: intentScore,
  };
}

/** Derive the coarse outcome label from signals. */
export function deriveOutcome(signals: IntentSignals): LegacyOutcome {
  const n = signals.negatives;
  if (n.do_not_call || n.explicit_not_interested || n.already_bought_competitor) {
    return "not_interested";
  }
  if (signals.facts.callback_requested) return "callback_requested";

  const strongish = (lvl: string) => lvl === "moderate" || lvl === "strong";
  if (strongish(signals.need.level) || strongish(signals.budget.level) || signals.facts.quantity) {
    return "interested";
  }
  return "unknown";
}

/** Build the legacy memory blob (drives intent_reason + follow-up scheduling). */
export function toLegacyMemory(signals: IntentSignals): LegacyMemory {
  const orNull = (s: string) => (s && s !== "unknown" ? s : null);
  return {
    requirement: orNull(signals.need.evidence),
    product_interest: orNull(signals.curiosity.evidence),
    quantity: signals.facts.quantity,
    intent_summary: signals.call_summary || "",
    followup_reason: signals.facts.callback_requested
      ? orNull(signals.timeline.evidence) || "callback requested"
      : null,
  };
}
