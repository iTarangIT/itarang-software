// Sarvam's webhook and APIs return no per-call cost (spec, unverified point 5),
// so cost is computed: talk seconds (ai_call_logs.call_duration, written by
// finalize from the webhook's `duration`) × SARVAM_COST_PER_MIN_INR.
//
// When the rate is not configured the fetch reports failure, which leaves
// cost_fetched_at null — the backfill cron retries once a rate is set.

import { db } from "@/lib/db";
import { aiCallLogs } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import type { NormalizedCallCost } from "../bolna_ai/fetchCallCost";
import { sarvamCostPerMinuteInr } from "./config";
import { sarvamCostPaise } from "./callHelpers";

export { sarvamCostPaise };

export async function fetchSarvamCallCost(
  attemptId: string,
): Promise<NormalizedCallCost> {
  const empty: NormalizedCallCost = {
    success: false,
    totalCents: null,
    llmCents: null,
    ttsCents: null,
    sttCents: null,
    telephonyCents: null,
    platformCents: null,
    durationSecs: null,
    currency: "INR",
    source: "duration_rate",
  };
  const rate = sarvamCostPerMinuteInr();
  if (rate == null) {
    return { ...empty, error: "SARVAM_COST_PER_MIN_INR not set" };
  }
  try {
    const [row] = await db
      .select({ duration: aiCallLogs.call_duration })
      .from(aiCallLogs)
      .where(eq(aiCallLogs.call_id, attemptId))
      .limit(1);
    if (!row) return { ...empty, error: "ai_call_logs row not found" };
    const durationSecs = row.duration ?? 0;
    return {
      ...empty,
      success: true,
      totalCents: sarvamCostPaise(durationSecs, rate),
      // Sarvam bills one bundled per-minute rate; no component split.
      platformCents: sarvamCostPaise(durationSecs, rate),
      durationSecs: null, // already authoritative on the row
    };
  } catch (err) {
    return { ...empty, error: err instanceof Error ? err.message : String(err) };
  }
}
