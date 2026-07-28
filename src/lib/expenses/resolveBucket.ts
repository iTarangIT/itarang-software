/**
 * E-218 — the single place a bucket is decided.
 *
 * Every write path goes through this: the Drive scanner, the manual uploader,
 * the bulk import and the backfill script. One function means a row imported
 * today and the same row re-imported next month cannot land in different
 * buckets — which is the whole point of a month-on-month comparison.
 *
 * Precedence, highest first:
 *   1. Rules   — a named vendor or keyword. Deterministic, free, never drifts.
 *   2. Model   — only if it whitelists AND clears the confidence floor.
 *   3. Default — "others", so the four tiles always sum to the total.
 *
 * Rules beat the model deliberately. When the CEO says a vendor is in the wrong
 * bucket, the fix is a line in bucketRules.ts that corrects every invoice from
 * that vendor at once; re-prompting would fix none of them retroactively.
 */
import {
  DEFAULT_EXPENSE_BUCKET,
  isExpenseBucket,
  type ExpenseBucket,
} from "@/lib/expenses";
import { bucketFromRules, type BucketRuleInput } from "./bucketRules";

/**
 * Below this the model is guessing. Matches MIN_DEPARTMENT_CONFIDENCE in
 * validateExpense.ts — the house floor for a low-confidence classification.
 */
export const MIN_BUCKET_CONFIDENCE = 0.5;

/** Who decided the bucket. Stored on the row as `bucket_source`. */
export type BucketSource = "rule" | "ai" | "manual" | "default";

export interface ResolveBucketInput extends BucketRuleInput {
  /** What the model returned, if a classification call was made. */
  aiBucket?: string | null;
  aiConfidence?: number | null;
}

export interface ResolvedBucket {
  bucket: ExpenseBucket;
  source: BucketSource;
  /** Which rule fired, or why the model's answer was not used. Null when trivial. */
  detail: string | null;
}

export function resolveBucket(input: ResolveBucketInput): ResolvedBucket {
  const ruled = bucketFromRules(input);
  if (ruled) {
    return { bucket: ruled.bucket, source: "rule", detail: ruled.rule };
  }

  const { aiBucket, aiConfidence } = input;
  if (isExpenseBucket(aiBucket)) {
    if (
      typeof aiConfidence === "number" &&
      Number.isFinite(aiConfidence) &&
      aiConfidence < MIN_BUCKET_CONFIDENCE
    ) {
      return {
        bucket: DEFAULT_EXPENSE_BUCKET,
        source: "default",
        detail: `model suggested "${aiBucket}" at ${Math.round(
          aiConfidence * 100,
        )}% — below the ${Math.round(MIN_BUCKET_CONFIDENCE * 100)}% floor`,
      };
    }
    return { bucket: aiBucket, source: "ai", detail: null };
  }

  return {
    bucket: DEFAULT_EXPENSE_BUCKET,
    source: "default",
    detail: "no rule matched and no usable classification",
  };
}
