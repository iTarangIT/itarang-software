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

export type {
  CallQualityFunnel,
  OpeningScriptStat,
} from "@/lib/ai-dialer/call-quality/funnel";

/**
 * What GET duration-histogram actually returns.
 *
 * The endpoint serves the histogram AND the funnel in one round trip so the
 * two can never disagree about which calls connected — see the note in
 * duration-histogram/route.ts. This alias is the wire shape; the two halves
 * keep their own types so neither module has to import the other.
 */
export type CallQualityResponse =
  import("@/lib/ai-dialer/call-duration/histogram").DurationHistogramResponse & {
    funnel: import("@/lib/ai-dialer/call-quality/funnel").CallQualityFunnel;
  };
