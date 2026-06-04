// Structured signals extracted from a call transcript by the LLM.
//
// CRITICAL CONTRACT: the LLM's ONLY job is to fill this shape with evidence.
// It must NOT emit a final intent score — the arithmetic lives in
// computeIntentScore.ts. Each leveled signal carries a level/enum AND a short
// verbatim-or-paraphrased `evidence` string ("unknown" when the transcript
// doesn't support it). "unknown" is first-class and distinct from "none"/"weak".
//
// The schema is intentionally forgiving: `.catch()` recovers a bad/garbled value
// to its conservative fallback ("unknown" → contributes 0) instead of failing
// the whole parse. A genuine failure (no JSON at all, network/timeout) is
// handled upstream in the extraction layer, not here.

import { z } from "zod";

// ── Level enums ──────────────────────────────────────────────────────────────

export const SIGNAL_LEVELS = ["unknown", "none", "weak", "moderate", "strong"] as const;
export const AUTHORITY_LEVELS = [
  "unknown",
  "decision_maker",
  "influencer",
  "not_decision_maker",
] as const;
export const TIMELINE_LEVELS = [
  "unknown",
  "now",
  "this_week",
  "this_month",
  "later",
  "none",
] as const;
export const OBJECTION_LEVELS = ["unknown", "none", "low", "substantive"] as const;
export const LANGUAGES = ["hindi", "english", "hinglish", "unknown"] as const;

export type SignalLevel = (typeof SIGNAL_LEVELS)[number];
export type AuthorityLevel = (typeof AUTHORITY_LEVELS)[number];
export type TimelineLevel = (typeof TIMELINE_LEVELS)[number];
export type ObjectionLevel = (typeof OBJECTION_LEVELS)[number];
export type LanguageType = (typeof LANGUAGES)[number];

// ── Schema ───────────────────────────────────────────────────────────────────

const evidence = z.string().catch("unknown");

function leveled<const T extends readonly [string, ...string[]]>(
  levels: T,
  fallback: T[number],
) {
  return z
    .object({
      level: z.enum(levels).catch(fallback),
      evidence,
    })
    .catch({ level: fallback, evidence: "unknown" });
}

export const IntentSignalsSchema = z.object({
  // BANT skeleton — each maps to something a dealer literally says.
  budget: leveled(SIGNAL_LEVELS, "unknown"), // EMI/financing interest, ability to fund
  authority: leveled(AUTHORITY_LEVELS, "unknown"), // owner / decision-maker?
  need: leveled(SIGNAL_LEVELS, "unknown"), // fleet/volume, pain, battery demand
  timeline: leveled(TIMELINE_LEVELS, "unknown"), // when they'll act

  // Call-quality signals.
  engagement: leveled(SIGNAL_LEVELS, "unknown"), // conversational depth
  curiosity: leveled(SIGNAL_LEVELS, "unknown"), // product questions
  objection_quality: leveled(OBJECTION_LEVELS, "unknown"), // substantive = engaged buyer

  // Extracted facts.
  facts: z
    .object({
      quantity: z.string().nullable().catch(null),
      callback_requested: z.boolean().catch(false),
      competitor_named: z.string().nullable().catch(null),
    })
    .catch({ quantity: null, callback_requested: false, competitor_named: null }),

  // Explicit negative signals.
  negatives: z
    .object({
      explicit_not_interested: z.boolean().catch(false),
      already_bought_competitor: z.boolean().catch(false),
      do_not_call: z.boolean().catch(false),
      hostile: z.boolean().catch(false),
      call_too_short: z.boolean().catch(false), // < ~20s / near-empty
    })
    .catch({
      explicit_not_interested: false,
      already_bought_competitor: false,
      do_not_call: false,
      hostile: false,
      call_too_short: false,
    }),

  language: z.enum(LANGUAGES).catch("unknown"),
  call_summary: z.string().catch(""),
  // Natural-language callback time if the dealer named one ("2 minute baad").
  // Parsed to an absolute time downstream; null when none.
  callback_time: z.string().nullable().catch(null),
});

export type IntentSignals = z.infer<typeof IntentSignalsSchema>;

// A neutral, all-"unknown" signal set. Used as a base for deep-merging partial
// LLM output and as the "no usable signal" sentinel.
export const EMPTY_SIGNALS: IntentSignals = IntentSignalsSchema.parse({});

// True when the extraction produced at least one usable signal. An all-unknown
// result means we couldn't understand the call — the caller should route it to
// needs_review rather than treat it as a (disqualifying) zero.
export function hasUsableSignal(s: IntentSignals): boolean {
  const leveledNonEmpty = (level: string) => level !== "unknown" && level !== "none";
  return (
    leveledNonEmpty(s.budget.level) ||
    s.authority.level !== "unknown" ||
    leveledNonEmpty(s.need.level) ||
    (s.timeline.level !== "unknown" && s.timeline.level !== "none") ||
    leveledNonEmpty(s.engagement.level) ||
    leveledNonEmpty(s.curiosity.level) ||
    (s.objection_quality.level !== "unknown" && s.objection_quality.level !== "none") ||
    s.facts.quantity !== null ||
    s.facts.callback_requested ||
    s.facts.competitor_named !== null ||
    s.negatives.explicit_not_interested ||
    s.negatives.already_bought_competitor ||
    s.negatives.do_not_call ||
    s.negatives.hostile ||
    s.negatives.call_too_short
  );
}
