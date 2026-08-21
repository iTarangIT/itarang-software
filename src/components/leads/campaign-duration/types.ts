// Wire types for GET /api/ai-dialer/campaigns/[id]/duration-histogram.
//
// Re-exported from the server module rather than restated, so the panel and the
// route cannot drift. These are `export type` on purpose: the histogram module
// imports drizzle's `sql`, and a value import would drag the whole query builder
// into the client bundle. Type-only imports are erased at compile time.
//
// The one runtime thing the client needs — the outcome family palette — lives in
// ./outcomeFamilies, which is deliberately free of any database import.
export type {
  DurationHistogramBucket,
  DurationHistogramResponse,
  DurationHistogramTotals,
  DurationOutcomeCode,
  DurationOutcomeSlice,
} from "@/lib/ai-dialer/call-duration/histogram";

export type { OutcomeFamily } from "@/lib/ai-dialer/call-duration/outcomeFamilies";
