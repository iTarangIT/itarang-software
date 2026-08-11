// Display-only Hot / Warm / Cold buckets for the merged /leads list.
//
// ⚠ DELIBERATELY SEPARATE from src/lib/ai/scoring/thresholds.ts. Do not "unify"
// the two — INTENT_THRESHOLDS (QUALIFIED 75, WARM 45, COLD 20) drives dialer
// routing, next-call delay (postCallHelpers), campaign qualification and lead
// status across ~10 call sites. These buckets drive nothing but what the user
// sees and filters by on the leads table. Changing the numbers here is safe;
// changing them there is not.
//
// ⚠ THERE IS A SECOND HOT/WARM/COLD ON THE SAME PAGE, AND IT DISAGREES.
// src/lib/ai-dialer/audience.ts `bucketOf()` buckets the AI Dialer's segment
// picker off INTENT_THRESHOLDS: hot >= 75 (agrees), warm >= 45 (disagrees with
// the 31 here). So a lead scoring 35 is "Cold" in the dialer modal and "Warm" in
// the leads filter. That divergence is ACCEPTED, not an oversight: moving
// audience.ts's floor would change which leads a "warm" campaign actually dials,
// which is a behaviour change, not a display change. The two are labelled apart
// in the UI — "Intent" on the table, "Dialer segment" in the modal.
//
// The boundaries were chosen against how scores are actually written. The
// scoring engine does not produce a continuous score — computeBand.ts emits one
// of four band constants (Qualified 90, Warm 60, Cold 30, Disqualified 0), so
// the cold/warm cut sits at 30 INCLUSIVE. A `< 30` cut would file every
// Cold-band lead under "Warm", which is the opposite of what it means.

export const INTENT_BUCKETS = {
  /** score >= 75 → Hot. Matches the Qualified band (90). */
  HOT_MIN: 75,
  /** score >= 31 → Warm. Matches the Warm band (60); leaves Cold (30) below. */
  WARM_MIN: 31,
} as const;

export type IntentBucket = "hot" | "warm" | "cold";

/** Bucket a raw intent score. A null/absent score counts as cold, not unknown —
 *  `final_intent_score` defaults to 0 in the DB, so "never called" is cold. */
export function intentBucketOf(score: number | null | undefined): IntentBucket {
  const s = score ?? 0;
  if (s >= INTENT_BUCKETS.HOT_MIN) return "hot";
  if (s >= INTENT_BUCKETS.WARM_MIN) return "warm";
  return "cold";
}

export const INTENT_BUCKET_LABEL: Record<IntentBucket, string> = {
  hot: "Hot",
  warm: "Warm",
  cold: "Cold",
};

/** Chip tone per bucket. Same border/bg/text triple the inside-sales chips use
 *  (StatusChip, InterestChip) so the merged row reads as one consistent set. */
export const INTENT_BUCKET_TONE: Record<IntentBucket, string> = {
  hot: "bg-rose-50 text-rose-700 border-rose-200",
  warm: "bg-amber-50 text-amber-700 border-amber-200",
  cold: "bg-sky-50 text-sky-700 border-sky-200",
};

/** Human-readable range, for filter-option labels and tooltips. */
export const INTENT_BUCKET_RANGE: Record<IntentBucket, string> = {
  hot: `${INTENT_BUCKETS.HOT_MIN}+`,
  warm: `${INTENT_BUCKETS.WARM_MIN}–${INTENT_BUCKETS.HOT_MIN - 1}`,
  cold: `0–${INTENT_BUCKETS.WARM_MIN - 1}`,
};

export const INTENT_BUCKET_OPTIONS: IntentBucket[] = ["hot", "warm", "cold"];

/** Type guard for an untrusted query-string value. */
export function isIntentBucket(v: string | null | undefined): v is IntentBucket {
  return v === "hot" || v === "warm" || v === "cold";
}
