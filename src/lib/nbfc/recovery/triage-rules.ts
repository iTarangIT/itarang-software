/**
 * E-292 — Recovery triage RULES (refurbish flow v3, R2/R3). Pure: no I/O,
 * unit-tested. The write path is triage.ts.
 *
 * health % = measured ÷ rated. The design's worked example is a 51 V pack
 * (> 40 V fit as-is · 35–40 V refurbish · < 35 V scrap); the thresholds here
 * are RATIOS of that example so a 48 V or 60 V pack is judged the same way.
 * The refurbishment floor is the same 70% the SOH machinery uses.
 */

/** 40 V of a 51 V pack. At or above this the battery is fit as-is. */
export const TRIAGE_FIT_MIN_PCT = 78.4;
/** 0.7 — the refurbishment floor. Mirrors SOH_REFURBISHABLE_MIN in stages.ts. */
export const TRIAGE_REFURB_MIN_PCT = 70;

export const TRIAGE_SUGGESTIONS = ["fit_as_is", "refurbish", "scrap"] as const;
export type TriageSuggestion = (typeof TRIAGE_SUGGESTIONS)[number];
export const TRIAGE_CHOICES = ["auction", "redeploy", "refurbish", "scrap"] as const;
export type TriageChoice = (typeof TRIAGE_CHOICES)[number];
export const TRIAGE_CONDITIONS = ["good", "fair", "poor"] as const;
export type TriageCondition = (typeof TRIAGE_CONDITIONS)[number];

export const TRIAGE_SUGGESTION_LABEL: Record<TriageSuggestion, string> = {
  fit_as_is: "Fit as-is — auction or redeploy",
  refurbish: "Refurbish (optional)",
  scrap: "Scrap — not suitable for refurbishing",
};

export const TRIAGE_CHOICE_LABEL: Record<TriageChoice, string> = {
  auction: "Auction as-is",
  redeploy: "Redeploy (iTarang helps)",
  refurbish: "Refurbish",
  scrap: "Scrap",
};

/** measured ÷ rated × 100, one decimal. Null when either side is missing or nonsense. */
export function healthPct(measured: number | null | undefined, rated: number | null | undefined): number | null {
  if (measured == null || rated == null) return null;
  if (!Number.isFinite(measured) || !Number.isFinite(rated) || rated <= 0 || measured < 0) return null;
  return Math.round((measured / rated) * 1000) / 10;
}

export function suggestTriage(health: number | null | undefined): TriageSuggestion | null {
  if (health == null || !Number.isFinite(health)) return null;
  if (health >= TRIAGE_FIT_MIN_PCT) return "fit_as_is";
  if (health >= TRIAGE_REFURB_MIN_PCT) return "refurbish";
  return "scrap";
}

/** The choices the NBFC may click for a given health figure. Refurbish is gated; the rest are theirs. */
export function allowedChoices(health: number | null | undefined): TriageChoice[] {
  const out: TriageChoice[] = ["auction", "redeploy", "scrap"];
  if (health != null && health >= TRIAGE_REFURB_MIN_PCT) out.splice(2, 0, "refurbish");
  return out;
}
