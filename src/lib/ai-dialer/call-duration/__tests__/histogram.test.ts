import { describe, expect, it } from "vitest";
import { deriveFailureReason, type FailureReasonInput } from "../../failureReason";
import { DEFAULT_DURATION_BUCKET_CONFIG, deriveBuckets } from "../config";
import {
    bucketDefsJson,
    classifyDurationOutcome,
    foldDurationHistogram,
    type DurationHistogramRow,
} from "../histogram";

const BUCKETS = deriveBuckets(DEFAULT_DURATION_BUCKET_CONFIG);
const CFG = { edgesSeconds: [20, 40, 60, 120, 300], source: "default" as const };

/** One row of the query's grain, with sane totals unless overridden. */
function row(over: Partial<DurationHistogramRow> = {}): DurationHistogramRow {
    return {
        bucket_ord: 1,
        bucket_key: "lt20",
        bucket_count: 0,
        bucket_total_seconds: 0,
        bucket_median_seconds: null,
        status: null,
        call_outcome: null,
        has_transcript: null,
        provider_status: null,
        band_call_status: null,
        n: null,
        campaign_leads: 0,
        completed_leads: 0,
        attempted_leads: 0,
        connected_leads: 0,
        connected_without_duration: 0,
        connected_total_seconds: 0,
        connected_median_seconds: null,
        ...over,
    };
}

describe("classifyDurationOutcome", () => {
    // The panel and the leads table must never disagree about why a call ended,
    // so this is defined as a wrapper over deriveFailureReason rather than a
    // second classifier. This test is the contract.
    const FIXTURES: FailureReasonInput[] = [
        { status: "completed", callOutcome: "push_to_crm", hasTranscript: true },
        { status: "completed", callOutcome: "dropped_empty", hasTranscript: true },
        { status: "completed", callOutcome: "unknown", hasTranscript: true },
        { status: "failed", callOutcome: "push_to_crm", hasTranscript: true },
        { status: "failed", callOutcome: "trigger_failed: 486 Busy Here", hasTranscript: false },
        { status: "failed", callOutcome: "trigger_failed: Invalid API key", hasTranscript: false },
        { status: "failed", callOutcome: "stopped_by_user", hasTranscript: false },
        { status: "failed", callOutcome: null, hasTranscript: false, providerStatus: "no_answer" },
        { status: "completed", callOutcome: null, hasTranscript: false },
    ];

    it.each(FIXTURES)('says "conversation" exactly when there is no failure to explain', (input) => {
        const reason = deriveFailureReason(input);
        const outcome = classifyDurationOutcome(input);

        if (reason === null) expect(outcome.code).toBe("conversation");
        else expect(outcome.code).toBe(reason.code);
    });

    it("carries the failure vocabulary's own label, hint and flags through", () => {
        const input: FailureReasonInput = {
            status: "failed",
            callOutcome: "trigger_failed: Invalid API key",
            hasTranscript: false,
        };
        const reason = deriveFailureReason(input)!;
        const outcome = classifyDurationOutcome(input);

        expect(outcome.label).toBe(reason.label);
        expect(outcome.hint).toBe(reason.hint);
        expect(outcome.ourFault).toBe(true);
    });
});

describe("bucketDefsJson", () => {
    it("emits ord/key/lo/hi for every bucket, with a null open top", () => {
        const parsed = JSON.parse(bucketDefsJson(BUCKETS));
        expect(parsed).toHaveLength(6);
        expect(parsed[0]).toEqual({ ord: 1, key: "lt20", lo: 0, hi: 20 });
        expect(parsed[5]).toEqual({ ord: 6, key: "gte300", lo: 300, hi: null });
    });
});

describe("foldDurationHistogram", () => {
    it("returns every configured bucket even with no rows at all", () => {
        const out = foldDurationHistogram([], BUCKETS, CFG, "camp_1");

        expect(out.buckets).toHaveLength(6);
        expect(out.buckets.map((b) => b.label)).toEqual([
            "<20s",
            "20–40s",
            "40–60s",
            "1–2m",
            "2–5m",
            ">5m",
        ]);
        for (const b of out.buckets) {
            expect(b.count).toBe(0);
            expect(b.share).toBe(0);
            expect(b.outcomes).toEqual([]);
            expect(Number.isNaN(b.share)).toBe(false);
        }
        expect(out.totals.averageConnectedSeconds).toBeNull();
        expect(out.totals.shortestBucketShare).toBe(0);
    });

    it("keeps an empty bucket empty rather than inventing an outcome", () => {
        // A bucket with no calls arrives as a LEFT JOIN filler: real bucket
        // columns, every outcome column null.
        const out = foldDurationHistogram(
            [row({ bucket_ord: 5, bucket_key: "s120_300", bucket_count: 0, n: null })],
            BUCKETS,
            CFG,
            "camp_1",
        );

        expect(out.buckets[4].count).toBe(0);
        expect(out.buckets[4].outcomes).toEqual([]);
        expect(out.buckets[4].medianSeconds).toBeNull();
    });

    it("accumulates distinct evidence tuples that mean the same reason", () => {
        const totals = {
            connected_leads: 4,
            connected_without_duration: 0,
            connected_total_seconds: 40,
        };
        const out = foldDurationHistogram(
            [
                row({
                    ...totals,
                    bucket_ord: 1,
                    bucket_count: 4,
                    bucket_total_seconds: 40,
                    bucket_median_seconds: 10,
                    status: "completed",
                    call_outcome: "dropped_empty",
                    has_transcript: true,
                    n: 3,
                }),
                row({
                    ...totals,
                    bucket_ord: 1,
                    bucket_count: 4,
                    bucket_total_seconds: 40,
                    bucket_median_seconds: 10,
                    status: "completed",
                    call_outcome: null,
                    has_transcript: true,
                    band_call_status: "dropped_empty",
                    n: 1,
                }),
            ],
            BUCKETS,
            CFG,
            "camp_1",
        );

        const first = out.buckets[0];
        expect(first.count).toBe(4);
        expect(first.outcomes).toHaveLength(1);
        expect(first.outcomes[0].code).toBe("silent_call");
        expect(first.outcomes[0].count).toBe(4);
        expect(first.outcomes[0].share).toBe(1);
        // The family rides on the slice, so a consumer can roll up by colour
        // without the response shipping a second tally that could disagree.
        expect(first.outcomes[0].family).toBe("silent");
    });

    it("orders outcomes by count, descending", () => {
        const common = { bucket_ord: 1, bucket_count: 10, connected_leads: 10 };
        const out = foldDurationHistogram(
            [
                row({
                    ...common,
                    status: "completed",
                    call_outcome: "dropped_empty",
                    has_transcript: true,
                    n: 2,
                }),
                row({
                    ...common,
                    status: "completed",
                    call_outcome: "unknown",
                    has_transcript: true,
                    n: 8,
                }),
            ],
            BUCKETS,
            CFG,
            "camp_1",
        );

        expect(out.buckets[0].outcomes.map((o) => o.count)).toEqual([8, 2]);
    });

    it("computes shares against the calls it could actually bucket", () => {
        // 10 connected, 2 of them with no usable duration -> 8 bucketed.
        const totals = {
            connected_leads: 10,
            connected_without_duration: 2,
            connected_total_seconds: 80,
        };
        const out = foldDurationHistogram(
            [
                row({ ...totals, bucket_ord: 1, bucket_count: 6 }),
                row({ ...totals, bucket_ord: 2, bucket_count: 2 }),
            ],
            BUCKETS,
            CFG,
            "camp_1",
        );

        expect(out.totals.bucketedConnected).toBe(8);
        expect(out.buckets[0].share).toBeCloseTo(0.75);
        expect(out.buckets[1].share).toBeCloseTo(0.25);
        expect(out.buckets.reduce((s, b) => s + b.share, 0)).toBeCloseTo(1);
        expect(out.totals.averageConnectedSeconds).toBe(10);
    });

    it("holds the connected = bucketed + unbucketed invariant", () => {
        const out = foldDurationHistogram(
            [
                row({
                    bucket_ord: 1,
                    bucket_count: 7,
                    connected_leads: 9,
                    connected_without_duration: 2,
                }),
            ],
            BUCKETS,
            CFG,
            "camp_1",
        );

        expect(out.totals.connectedLeads).toBe(
            out.totals.bucketedConnected + out.totals.connectedWithoutDuration,
        );
    });

    it("normalises the strings postgres returns for wide integer types", () => {
        const out = foldDurationHistogram(
            [
                row({
                    bucket_ord: "1" as unknown as number,
                    bucket_count: "12" as unknown as number,
                    bucket_median_seconds: "9" as unknown as number,
                    connected_leads: "12" as unknown as number,
                    connected_total_seconds: "144" as unknown as number,
                }),
            ],
            BUCKETS,
            CFG,
            "camp_1",
        );

        expect(out.buckets[0].count).toBe(12);
        expect(out.buckets[0].medianSeconds).toBe(9);
        expect(out.totals.connectedLeads).toBe(12);
        expect(out.totals.averageConnectedSeconds).toBe(12);
    });

    it("reports the first bucket as the headline short-call figure", () => {
        const out = foldDurationHistogram(
            [
                row({ bucket_ord: 1, bucket_count: 47, connected_leads: 60 }),
                row({ bucket_ord: 2, bucket_count: 13, connected_leads: 60 }),
            ],
            BUCKETS,
            CFG,
            "camp_1",
        );

        expect(out.totals.shortestBucketCount).toBe(47);
        expect(out.totals.shortestBucketShare).toBeCloseTo(47 / 60);
    });

    it("echoes the configuration that produced it", () => {
        const out = foldDurationHistogram([], BUCKETS, { ...CFG, source: "app_settings" }, "camp_9");
        expect(out.campaignId).toBe("camp_9");
        expect(out.config).toEqual({ edgesSeconds: [20, 40, 60, 120, 300], source: "app_settings" });
    });
});
