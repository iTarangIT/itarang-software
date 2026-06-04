// The weight table for computeIntentScore. EVERY number here is a named,
// documented constant — no magic numbers scattered across the codebase.
//
// Positive contributions are designed to sum to EXACTLY 100 at full strength, so
// the intent score is a transparent "% of an ideal buyer". A signal contributes
// `weight * fraction(level)`, rounded to an integer point value.

import type { SignalLevel, TimelineLevel, ObjectionLevel } from "./signals";

// Max points each positive signal can contribute. Sum === 100.
//   need        — the strongest predictor: real fleet/volume/pain to solve.
//   budget      — willingness/ability to fund (EMI interest) — close behind need.
//   engagement  — depth of the conversation; a proxy for genuine attention.
//   curiosity   — product questions; buying-adjacent but weaker than need/budget.
//   timeline    — WHEN they'll act; soft (a "later" dealer is still a lead).
//   objection_quality — substantive objections mean an engaged, evaluating buyer.
export const SIGNAL_WEIGHTS = {
  need: 30,
  budget: 25,
  engagement: 15,
  curiosity: 12,
  timeline: 10,
  objection_quality: 8,
} as const;

// Sanity constant — used by a unit test to assert the table still totals 100.
export const MAX_POSITIVE_SCORE = 100;

// Generic level → fraction of the signal's weight.
export const LEVEL_FRACTION: Record<SignalLevel, number> = {
  unknown: 0,
  none: 0,
  weak: 0.34,
  moderate: 0.67,
  strong: 1,
};

// Timeline is soft: "later" REDUCES the score but never zeros it (a "not now"
// dealer is a nurture lead, per standard BANT practice — timeline is not a hard
// disqualifier).
export const TIMELINE_FRACTION: Record<TimelineLevel, number> = {
  unknown: 0,
  none: 0,
  later: 0.2,
  this_month: 0.5,
  this_week: 0.8,
  now: 1,
};

// A substantive objection is a positive signal (engaged buyer pushing back);
// a low/none objection adds little.
export const OBJECTION_FRACTION: Record<ObjectionLevel, number> = {
  unknown: 0,
  none: 0,
  low: 0.4,
  substantive: 1,
};

// Negative caps: when a flag is set, the FINAL score cannot exceed this value,
// regardless of positive signals. The lowest applicable cap wins. This is how a
// flat rejection / competitor-bought / do-not-call floors the number LOW.
export const NEGATIVE_CAPS = {
  do_not_call: 0,
  already_bought_competitor: 10,
  explicit_not_interested: 12,
  hostile: 8,
  // A near-empty / <20s call can't be qualified, but absence of info is NOT a
  // rejection — cap, don't zero.
  call_too_short: 25,
} as const;
