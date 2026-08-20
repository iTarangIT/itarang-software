import { describe, expect, it, vi } from "vitest";
import {
    DEFAULT_DURATION_BUCKET_CONFIG,
    MAX_DURATION_EDGES,
    bucketFor,
    deriveBuckets,
    formatBucketLabel,
    mergeDurationBucketConfig,
    validateEdges,
} from "../config";

const DEFAULT_BUCKETS = deriveBuckets(DEFAULT_DURATION_BUCKET_CONFIG);

describe("deriveBuckets", () => {
    it("produces exactly the six labels the team asked for", () => {
        expect(DEFAULT_BUCKETS.map((b) => b.label)).toEqual([
            "<20s",
            "20–40s",
            "40–60s",
            "1–2m",
            "2–5m",
            ">5m",
        ]);
    });

    it("produces half-open bounds that tile [0, inf) exactly once", () => {
        expect(DEFAULT_BUCKETS.map((b) => [b.loSeconds, b.hiSeconds])).toEqual([
            [0, 20],
            [20, 40],
            [40, 60],
            [60, 120],
            [120, 300],
            [300, null],
        ]);
    });

    it("gives every bucket a stable key derived from its bounds", () => {
        expect(DEFAULT_BUCKETS.map((b) => b.key)).toEqual([
            "lt20",
            "s20_40",
            "s40_60",
            "s60_120",
            "s120_300",
            "gte300",
        ]);
    });

    it("spells the bounds out for screen readers", () => {
        expect(DEFAULT_BUCKETS[0].aria).toBe("Under 20 seconds");
        expect(DEFAULT_BUCKETS[3].aria).toBe("1 minute to 2 minutes");
        expect(DEFAULT_BUCKETS[5].aria).toBe("5 minutes and over");
    });

    it("numbers buckets from 1, ascending — the SQL joins on this", () => {
        expect(DEFAULT_BUCKETS.map((b) => b.ord)).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it("N edges give N+1 buckets", () => {
        expect(deriveBuckets({ edgesSeconds: [30], labels: null })).toHaveLength(2);
        expect(deriveBuckets({ edgesSeconds: [10, 20, 30, 40], labels: null })).toHaveLength(5);
    });

    it("uses a label override only when it covers every bucket", () => {
        const cfg = { edgesSeconds: [20], labels: ["quick", "slow"] };
        expect(deriveBuckets(cfg).map((b) => b.label)).toEqual(["quick", "slow"]);

        const short = { edgesSeconds: [20], labels: ["quick"] };
        expect(deriveBuckets(short).map((b) => b.label)).toEqual(["<20s", ">20s"]);
    });
});

describe("formatBucketLabel", () => {
    it.each([
        [0, 20, "<20s"],
        [20, 40, "20–40s"],
        [60, 120, "1–2m"],
        [120, 300, "2–5m"],
        [300, null, ">5m"],
        [0, 90, "<1.5m"],
    ])("formats (%p, %p) as %s", (lo, hi, expected) => {
        expect(formatBucketLabel(lo, hi as number | null)).toBe(expected);
    });
});

// The whole feature turns on the 20-second line, so the boundary behaviour gets
// an explicit table rather than being inferred from the implementation.
describe("bucketFor — the half-open boundary rule", () => {
    it.each([
        [1, "<20s"],
        [19, "<20s"],
        [20, "20–40s"], // NOT "<20s" — the label means strictly under 20
        [39, "20–40s"],
        [40, "40–60s"],
        [59, "40–60s"],
        [60, "1–2m"],
        [119, "1–2m"],
        [120, "2–5m"],
        [299, "2–5m"],
        [300, ">5m"],
        [99999, ">5m"],
    ])("puts a %ps call in %s", (seconds, label) => {
        expect(bucketFor(seconds, DEFAULT_BUCKETS)?.label).toBe(label);
    });

    it.each([null, undefined, 0, -5, Number.NaN])("has no bucket for %p", (seconds) => {
        expect(bucketFor(seconds as number | null, DEFAULT_BUCKETS)).toBeNull();
    });

    it("assigns every whole second to exactly one bucket", () => {
        for (let s = 1; s <= 1000; s++) {
            const matches = DEFAULT_BUCKETS.filter(
                (b) => s >= b.loSeconds && (b.hiSeconds === null || s < b.hiSeconds),
            );
            expect(matches, `duration ${s}s matched ${matches.length} buckets`).toHaveLength(1);
        }
    });
});

// The SQL bins by joining against the bucket list, so an overlap would
// double-count a call. This asserts overlap is impossible by construction.
describe("non-overlap property", () => {
    const EDGE_SETS = [
        [20, 40, 60, 120, 300],
        [5, 10, 20],
        [1],
        [15, 30, 45, 60, 90, 120, 180, 240, 300, 600],
    ];

    it.each(EDGE_SETS)("tiles contiguously for edges %j", (...edges) => {
        const buckets = deriveBuckets({ edgesSeconds: edges as number[], labels: null });

        expect(buckets[0].loSeconds).toBe(0);
        expect(buckets[buckets.length - 1].hiSeconds).toBeNull();

        for (let i = 1; i < buckets.length; i++) {
            expect(buckets[i].loSeconds).toBe(buckets[i - 1].hiSeconds);
        }

        for (let s = 1; s <= 1000; s++) {
            const matches = buckets.filter(
                (b) => s >= b.loSeconds && (b.hiSeconds === null || s < b.hiSeconds),
            );
            expect(matches).toHaveLength(1);
        }
    });
});

describe("validateEdges", () => {
    it("accepts the defaults", () => {
        expect(validateEdges([20, 40, 60, 120, 300])).toBeNull();
    });

    it.each([
        { why: "an empty list", edges: [] },
        { why: "a duplicate edge", edges: [20, 20] },
        { why: "descending edges", edges: [40, 20] },
        { why: "a zero edge", edges: [0, 20] },
        { why: "a negative edge", edges: [-5] },
        { why: "a fractional edge", edges: [20.5] },
        { why: "a numeric string", edges: [20, "40"] },
        { why: "NaN", edges: [20, Number.NaN] },
        { why: "an edge beyond the clamp", edges: [8000] },
        { why: "not an array", edges: null },
        { why: "a string", edges: "20,40" },
        { why: "an object", edges: { a: 1 } },
    ])("rejects $why", ({ edges }) => {
        expect(validateEdges(edges)).toBeTypeOf("string");
    });

    it("rejects more edges than the chart can render", () => {
        const tooMany = Array.from({ length: MAX_DURATION_EDGES + 1 }, (_, i) => (i + 1) * 10);
        expect(validateEdges(tooMany)).toContain(String(MAX_DURATION_EDGES));
    });
});

describe("mergeDurationBucketConfig", () => {
    it.each([undefined, null, "nope", 42, [], { edgesSeconds: "x" }, { edgesSeconds: [40, 20] }])(
        "degrades %j to the defaults",
        (patch) => {
            const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
            expect(mergeDurationBucketConfig(patch).edgesSeconds).toEqual(
                DEFAULT_DURATION_BUCKET_CONFIG.edgesSeconds,
            );
            warn.mockRestore();
        },
    );

    it("applies a valid override", () => {
        expect(mergeDurationBucketConfig({ edgesSeconds: [10, 30] }).edgesSeconds).toEqual([10, 30]);
    });

    it("ignores a wrong-length label list but keeps the edges", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const merged = mergeDurationBucketConfig({
            edgesSeconds: [10, 30],
            labels: ["only", "two"],
        });
        expect(merged.edgesSeconds).toEqual([10, 30]);
        expect(merged.labels).toBeNull();
        warn.mockRestore();
    });

    it("accepts a label list that covers every bucket", () => {
        const merged = mergeDurationBucketConfig({
            edgesSeconds: [10, 30],
            labels: ["a", "b", "c"],
        });
        expect(merged.labels).toEqual(["a", "b", "c"]);
    });

    it("does not mutate the defaults", () => {
        const merged = mergeDurationBucketConfig({ edgesSeconds: [7] });
        merged.edgesSeconds.push(99);
        expect(DEFAULT_DURATION_BUCKET_CONFIG.edgesSeconds).toEqual([20, 40, 60, 120, 300]);
    });
});
