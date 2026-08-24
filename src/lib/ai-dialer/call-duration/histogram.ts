/**
 * The campaign call-duration distribution: one campaign, one round trip.
 *
 * WHAT THIS ANSWERS
 *   "How fast are this campaign's connected calls dying, and why?" Production
 *   data says the median AI call runs about eleven seconds and roughly seven in
 *   ten connected calls end inside twenty. Until now that lived in an offline
 *   script nobody runs. This puts it on the campaign screen, scoped to the one
 *   campaign in front of you.
 *
 * WHY THE AGGREGATE IS SERVER-SIDE
 *   The obvious shortcut is to bucket the rows the leads table already loaded.
 *   That table caps at 100 rows per status (BANNER_LIMIT) or 50 per page
 *   (PAGE_SIZE), so on any real campaign the shortcut produces a confident,
 *   precise, WRONG number — the exact failure this panel exists to prevent.
 *
 * SHAPE OF THE QUERY
 *   lead_call    every campaign lead + its one authoritative ai_call_logs row
 *   connected    the ones that actually reached a dealer (../call-duration/derive)
 *   bucket_defs  the configured edges, arriving as ONE json bind parameter
 *   binned       connected calls with a known duration, joined to their bucket
 *   bucket_stats per-bucket count / total / median, LEFT JOINed so empties survive
 *   outcome_mix  per-bucket evidence tuples, folded into reasons in TypeScript
 *   totals       the denominators, computed over lead_call so nothing is lost
 *
 * FOUR THINGS THAT LOOK LIKE STYLE AND ARE NOT
 *
 *   0. `is_connected` and `duration_seconds` are BOUND FROM ../derive, not
 *      written out here. This CTE used to carry its own copy of both — an
 *      inlined CASE and a local `has_transcript IS TRUE OR duration_seconds > 0`
 *      — which is exactly the four-copies problem derive.ts's header warns
 *      about, and it is why fixing the rule there did not reach this query. The
 *      copy accepted the campaign-lead wall clock as proof a call connected, so
 *      every trigger_failed lead (provider rejected the trigger, no phone ever
 *      rang) was bucketed by how long the dialer took to fail: one production
 *      campaign of 146 leads reported all 146 as measured calls when only 71
 *      had completed. buildDurationHistogramSql is now pinned in
 *      __tests__/histogram.test.ts against the shared predicate strings, so a
 *      re-inlined copy fails the suite rather than drifting quietly.
 *
 *   1. LEFT JOIN LATERAL ... LIMIT 1, not four correlated subqueries.
 *      ai_call_logs_call_id_idx is NOT unique, and the leads route currently
 *      fires four independent unordered subqueries against it — nothing makes
 *      them read the same row, so a duration can come from one attempt while
 *      the transcript flag comes from another. One LATERAL with an explicit
 *      ORDER BY reads five columns from one deterministic row. A plain LEFT
 *      JOIN (as unified/route.ts uses) would multiply rows outright and inflate
 *      every count here.
 *
 *   2. Bucket edges travel as ${JSON.stringify(...)}::jsonb, the house pattern
 *      (aiConnection.ts, audience.ts, dedupe.ts). Config numbers never become
 *      SQL text, so even a hostile app_settings row can only produce a
 *      badly-shaped document, never a statement. width_bucket() was the
 *      alternative and needs a real PG array parameter, which postgres-js
 *      serialises with no type information — the same mechanism that throws
 *      ERR_INVALID_ARG_TYPE on a Date.
 *
 *   3. No JS Date crosses the boundary in either direction. Timestamps are
 *      subtracted inside Postgres. See the note above about why that matters.
 *
 * The fold is a separate pure function with no db import, so all of the
 * arithmetic that turns rows into percentages is unit-testable without a
 * DATABASE_URL.
 */
import { sql, type SQL } from "drizzle-orm";
import {
    deriveFailureReason,
    type FailureReasonCode,
    type FailureReasonInput,
} from "../failureReason";
import { classifyOutcomeFamily, type OutcomeFamily } from "./outcomeFamilies";
import { CONNECTED_SQL, DURATION_SECONDS_SQL } from "./derive";
import type { DurationBucket } from "./config";

/** A failure code, or the success member the failure vocabulary has no word for. */
export type DurationOutcomeCode = FailureReasonCode | "conversation";

export interface DurationOutcomeSlice {
    code: DurationOutcomeCode;
    family: OutcomeFamily;
    /** "Silent call" | "Not answered" | "Conversation" ... */
    label: string;
    /** One line of "so what", straight from the failureReason spec. */
    hint: string;
    retryable: boolean;
    /** True when the failure was OURS, not the dealer's. Lights a callout. */
    ourFault: boolean;
    count: number;
    /** 0..1 within this bucket. 0 when the bucket is empty. */
    share: number;
}

export interface DurationHistogramBucket {
    key: string;
    label: string;
    aria: string;
    /** INCLUSIVE lower bound, seconds. */
    loSeconds: number;
    /** EXCLUSIVE upper bound, seconds. null means open-ended. */
    hiSeconds: number | null;
    count: number;
    /** 0..1 of totals.bucketedConnected. */
    share: number;
    totalSeconds: number;
    medianSeconds: number | null;
    /**
     * Per-code detail, descending by count. [] for an empty bucket.
     *
     * There is deliberately no separate per-family tally alongside this: each
     * slice already carries its `family`, so a rollup is a one-line reduce on
     * whichever consumer wants one. Shipping both invites them to disagree.
     */
    outcomes: DurationOutcomeSlice[];
}

export interface DurationHistogramTotals {
    campaignLeads: number;
    /** status = 'completed' — what the Completed stat card counts. */
    completedLeads: number;
    /** status <> 'pending' — every lead we actually tried to dial. */
    attemptedLeads: number;
    /** Reached a dealer: a transcript, or measurable talk time. */
    connectedLeads: number;
    /** Connected AND we know how long. The histogram's real denominator. */
    bucketedConnected: number;
    /** Connected but no usable duration, so present in no bar. */
    connectedWithoutDuration: number;
    totalTalkSeconds: number;
    medianConnectedSeconds: number | null;
    averageConnectedSeconds: number | null;
    /** Calls in the first bucket, and their share of bucketedConnected (0..1). */
    shortestBucketCount: number;
    shortestBucketShare: number;
}

export interface DurationHistogramResponse {
    campaignId: string;
    buckets: DurationHistogramBucket[];
    totals: DurationHistogramTotals;
    config: {
        edgesSeconds: number[];
        source: "default" | "app_settings";
    };
}

/** One row of the query's (bucket x evidence tuple) grain, totals cross-joined. */
export interface DurationHistogramRow {
    bucket_ord: number | string;
    bucket_key: string;
    bucket_count: number | string;
    bucket_total_seconds: number | string;
    bucket_median_seconds: number | string | null;

    // The evidence tuple. All null on a bucket with no calls in it.
    status: string | null;
    call_outcome: string | null;
    has_transcript: boolean | null;
    provider_status: string | null;
    band_call_status: string | null;
    n: number | string | null;

    campaign_leads: number | string;
    completed_leads: number | string;
    attempted_leads: number | string;
    connected_leads: number | string;
    connected_without_duration: number | string;
    connected_total_seconds: number | string;
    connected_median_seconds: number | string | null;
}

/**
 * The reason a call ended, including the one the failure vocabulary omits.
 *
 * deriveFailureReason returns null for a call that SUCCEEDED, because its job is
 * explaining failures. A histogram has to name that case, so this wraps it with
 * a "conversation" member. Keeping the wrap here — rather than reimplementing
 * the classification — is what stops this panel and the leads table from ever
 * disagreeing about why a given call ended.
 */
export function classifyDurationOutcome(input: FailureReasonInput): {
    code: DurationOutcomeCode;
    label: string;
    hint: string;
    retryable: boolean;
    ourFault: boolean;
} {
    const reason = deriveFailureReason(input);
    if (!reason) {
        return {
            code: "conversation",
            label: "Conversation",
            hint: "The AI and the dealer had a real exchange.",
            retryable: false,
            ourFault: false,
        };
    }
    return {
        code: reason.code,
        label: reason.label,
        hint: reason.hint,
        retryable: reason.retryable,
        ourFault: reason.ourFault,
    };
}

/**
 * The bucket list as the json the query binds.
 *
 * Exported so the verification script can drive the real CTE against synthetic
 * durations instead of restating the boundary arithmetic — a restated copy
 * passes forever while the real thing drifts underneath it.
 */
export function bucketDefsJson(buckets: DurationBucket[]): string {
    return JSON.stringify(
        buckets.map((b) => ({
            ord: b.ord,
            key: b.key,
            lo: b.loSeconds,
            hi: b.hiSeconds,
        })),
    );
}

/**
 * Bucket boundaries are HALF-OPEN: [lo, hi). See ./config for why.
 *
 * The comparison lives here as a fragment so the leads route's durationBucket
 * filter can bind the exact same predicate. If these two ever diverge, a bar
 * will say 47 and the table it filters will return 44.
 */
export const BUCKET_MATCH_PREDICATE =
    "c.duration_seconds >= bd.lo AND (bd.hi IS NULL OR c.duration_seconds < bd.hi)";

export function buildDurationHistogramSql(campaignId: string, buckets: DurationBucket[]): SQL {
    const defs = bucketDefsJson(buckets);

    return sql`
WITH lead_call AS (
  SELECT
      dcl.id,
      dcl.status,
      dcl.call_outcome,
      acl.transcript IS NOT NULL AS has_transcript,
      acl.status                 AS provider_status,
      acl.call_status            AS band_call_status,
      ${CONNECTED_SQL}           AS is_connected,
      ${DURATION_SECONDS_SQL}    AS duration_seconds
    FROM dialer_campaign_leads dcl
    LEFT JOIN LATERAL (
      SELECT a.call_duration, a.transcript, a.status, a.call_status
        FROM ai_call_logs a
       WHERE a.call_id = dcl.bolna_call_id
       ORDER BY a.updated_at DESC NULLS LAST
       LIMIT 1
    ) acl ON TRUE
   WHERE dcl.campaign_id = ${campaignId}
),
connected AS (
  SELECT * FROM lead_call WHERE is_connected
),
bucket_defs AS (
  SELECT (b.value->>'ord')::int  AS bucket_ord,
         (b.value->>'key')::text AS bucket_key,
         (b.value->>'lo')::int   AS lo,
         (b.value->>'hi')::int   AS hi
    FROM jsonb_array_elements(${defs}::jsonb) AS b(value)
),
binned AS (
  SELECT c.*, bd.bucket_ord, bd.bucket_key
    FROM connected c
    JOIN bucket_defs bd
      ON c.duration_seconds >= bd.lo
     AND (bd.hi IS NULL OR c.duration_seconds < bd.hi)
   WHERE c.duration_seconds IS NOT NULL
),
bucket_stats AS (
  SELECT bd.bucket_ord,
         bd.bucket_key,
         count(b.id)::int                          AS bucket_count,
         COALESCE(sum(b.duration_seconds), 0)::int AS bucket_total_seconds,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY b.duration_seconds)::int
                                                   AS bucket_median_seconds
    FROM bucket_defs bd
    LEFT JOIN binned b ON b.bucket_ord = bd.bucket_ord
   GROUP BY bd.bucket_ord, bd.bucket_key
),
outcome_mix AS (
  SELECT bucket_ord,
         status,
         call_outcome,
         COALESCE(has_transcript, false) AS has_transcript,
         provider_status,
         band_call_status,
         count(*)::int AS n
    FROM binned
   GROUP BY 1, 2, 3, 4, 5, 6
),
totals AS (
  SELECT
    count(*)::int                                                              AS campaign_leads,
    count(*) FILTER (WHERE status = 'completed')::int                          AS completed_leads,
    count(*) FILTER (WHERE status <> 'pending')::int                           AS attempted_leads,
    count(*) FILTER (WHERE is_connected)::int                                  AS connected_leads,
    count(*) FILTER (WHERE is_connected AND duration_seconds IS NULL)::int     AS connected_without_duration,
    COALESCE(sum(duration_seconds) FILTER (WHERE is_connected), 0)::int        AS connected_total_seconds,
    (percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_seconds)
       FILTER (WHERE is_connected))::int                                       AS connected_median_seconds
    FROM lead_call
)
SELECT bs.bucket_ord, bs.bucket_key, bs.bucket_count,
       bs.bucket_total_seconds, bs.bucket_median_seconds,
       om.status, om.call_outcome, om.has_transcript,
       om.provider_status, om.band_call_status, om.n,
       t.campaign_leads, t.completed_leads, t.attempted_leads,
       t.connected_leads, t.connected_without_duration,
       t.connected_total_seconds, t.connected_median_seconds
  FROM bucket_stats bs
  LEFT JOIN outcome_mix om ON om.bucket_ord = bs.bucket_ord
  CROSS JOIN totals t
 ORDER BY bs.bucket_ord ASC, om.n DESC NULLS LAST`;
}

/** Postgres hands back bigint/numeric as strings; normalise once, at the edge. */
function num(v: number | string | null | undefined): number {
    if (v == null) return 0;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : 0;
}

function numOrNull(v: number | string | null | undefined): number | null {
    if (v == null) return null;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : null;
}

/**
 * Rows to the response the panel renders.
 *
 * Pure on purpose. Every percentage the UI shows is computed here, so the
 * division-by-zero cases (an empty campaign, an empty bucket) are covered by
 * unit tests rather than discovered by a NaN on someone's screen.
 */
export function foldDurationHistogram(
    rows: DurationHistogramRow[],
    buckets: DurationBucket[],
    cfg: { edgesSeconds: number[]; source: "default" | "app_settings" },
    campaignId: string,
): DurationHistogramResponse {
    const byOrd = new Map<number, DurationHistogramRow[]>();
    for (const row of rows) {
        const ord = num(row.bucket_ord);
        const list = byOrd.get(ord);
        if (list) list.push(row);
        else byOrd.set(ord, [row]);
    }

    // Totals are cross-joined onto every row, so any row carries them. With no
    // buckets configured there are no rows at all, hence the zero fallback.
    const anyRow = rows[0];
    const connectedLeads = anyRow ? num(anyRow.connected_leads) : 0;
    const connectedWithoutDuration = anyRow ? num(anyRow.connected_without_duration) : 0;
    const bucketedConnected = connectedLeads - connectedWithoutDuration;
    const totalTalkSeconds = anyRow ? num(anyRow.connected_total_seconds) : 0;

    const shapedBuckets: DurationHistogramBucket[] = buckets.map((bucket) => {
        const bucketRows = byOrd.get(bucket.ord) ?? [];
        const head = bucketRows[0];
        const count = head ? num(head.bucket_count) : 0;

        // Per-code tally. Several evidence tuples can classify to the same
        // reason, so accumulate rather than assuming one row per code.
        const byCode = new Map<DurationOutcomeCode, DurationOutcomeSlice>();

        for (const row of bucketRows) {
            if (row.n == null) continue; // LEFT JOIN filler for an empty bucket
            const n = num(row.n);
            if (n <= 0) continue;

            const outcome = classifyDurationOutcome({
                status: row.status,
                callOutcome: row.call_outcome,
                hasTranscript: row.has_transcript,
                providerStatus: row.provider_status,
                bandCallStatus: row.band_call_status,
            });

            const family = classifyOutcomeFamily(
                outcome.code === "conversation" ? null : (outcome.code as FailureReasonCode),
            );

            const existing = byCode.get(outcome.code);
            if (existing) existing.count += n;
            else {
                byCode.set(outcome.code, {
                    code: outcome.code,
                    family,
                    label: outcome.label,
                    hint: outcome.hint,
                    retryable: outcome.retryable,
                    ourFault: outcome.ourFault,
                    count: n,
                    share: 0,
                });
            }
        }

        const outcomes = [...byCode.values()]
            .map((slice) => ({ ...slice, share: count > 0 ? slice.count / count : 0 }))
            .sort((a, b) => b.count - a.count);

        return {
            key: bucket.key,
            label: bucket.label,
            aria: bucket.aria,
            loSeconds: bucket.loSeconds,
            hiSeconds: bucket.hiSeconds,
            count,
            share: bucketedConnected > 0 ? count / bucketedConnected : 0,
            totalSeconds: head ? num(head.bucket_total_seconds) : 0,
            medianSeconds: head ? numOrNull(head.bucket_median_seconds) : null,
            outcomes,
        };
    });

    const shortest = shapedBuckets[0];

    return {
        campaignId,
        buckets: shapedBuckets,
        totals: {
            campaignLeads: anyRow ? num(anyRow.campaign_leads) : 0,
            completedLeads: anyRow ? num(anyRow.completed_leads) : 0,
            attemptedLeads: anyRow ? num(anyRow.attempted_leads) : 0,
            connectedLeads,
            bucketedConnected,
            connectedWithoutDuration,
            totalTalkSeconds,
            medianConnectedSeconds: anyRow ? numOrNull(anyRow.connected_median_seconds) : null,
            averageConnectedSeconds:
                bucketedConnected > 0 ? Math.round(totalTalkSeconds / bucketedConnected) : null,
            shortestBucketCount: shortest?.count ?? 0,
            shortestBucketShare: shortest?.share ?? 0,
        },
        config: {
            edgesSeconds: [...cfg.edgesSeconds],
            source: cfg.source,
        },
    };
}
