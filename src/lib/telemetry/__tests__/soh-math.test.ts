import { describe, expect, it } from "vitest";
import {
    assessWarrantyFeed,
    classifySohFeed,
    type SohTrendPoint,
} from "@/lib/telemetry/soh-math";

const day = (min: number, max: number, avg = (min + max) / 2): SohTrendPoint => ({
    avg_soh: avg,
    min_soh: min,
    max_soh: max,
});

describe("classifySohFeed", () => {
    it("calls a series with no spread on any day and no change across days constant", () => {
        const rows = Array.from({ length: 30 }, () => day(100, 100));
        expect(classifySohFeed(rows)).toEqual({ kind: "constant", value: 100, days: 30 });
    });

    it("charts a series that actually varies", () => {
        const rows = [day(82, 99), day(81, 99), day(80, 98)];
        expect(classifySohFeed(rows)).toEqual({ kind: "informative" });
    });

    it("catches a fleet that is flat on each day but drifts across days", () => {
        // Every pack agrees on any given day, yet the fleet declines over time. The
        // spread is zero daily but the signal is real, so this must chart.
        const rows = [day(100, 100), day(99, 99), day(98, 98)];
        expect(classifySohFeed(rows)).toEqual({ kind: "informative" });
    });

    it("catches a fleet that is constant across days but spread within a day", () => {
        const rows = [day(80, 100), day(80, 100)];
        expect(classifySohFeed(rows)).toEqual({ kind: "informative" });
    });

    it("distinguishes an empty feed from a constant one", () => {
        expect(classifySohFeed([])).toEqual({ kind: "empty" });
        expect(classifySohFeed([day(100, 100)])).toEqual({ kind: "constant", value: 100, days: 1 });
    });

    it("treats rows with no readings as absent rather than as data", () => {
        const rows: SohTrendPoint[] = [
            { avg_soh: null, min_soh: null, max_soh: null },
            { avg_soh: null, min_soh: null, max_soh: null },
        ];
        expect(classifySohFeed(rows)).toEqual({ kind: "empty" });
    });

    it("ignores unreadable rows but still judges the readable ones", () => {
        const rows: SohTrendPoint[] = [
            { avg_soh: null, min_soh: null, max_soh: null },
            day(100, 100),
            day(100, 100),
        ];
        expect(classifySohFeed(rows)).toEqual({ kind: "constant", value: 100, days: 2 });
    });

    it("does not let a NaN reading masquerade as variation", () => {
        const rows: SohTrendPoint[] = [day(100, 100), { avg_soh: NaN, min_soh: NaN, max_soh: NaN }];
        expect(classifySohFeed(rows)).toEqual({ kind: "constant", value: 100, days: 1 });
    });

    it("is not fooled by an average that varies while min and max do not", () => {
        // avg drifts only because the per-day pack mix changed; no pack ever left 100.
        const rows = [day(100, 100, 100), day(100, 100, 99.97), day(100, 100, 100)];
        expect(classifySohFeed(rows)).toEqual({ kind: "constant", value: 100, days: 3 });
    });

    describe("against the live fleet reading (polar review cache, 2026-07-13)", () => {
        it("classifies the real feed — 297 packs all at exactly 100.0 — as constant", () => {
            // V10_soh: avg_soh 100.0, min_soh 100, max_soh 100, soh_exactly_100 297, soh_null 13.
            // This is the exact shape that renders today as a flat line at 100 and "0 at-risk".
            const rows = Array.from({ length: 30 }, () => day(100, 100, 100));
            const verdict = classifySohFeed(rows);
            expect(verdict.kind).toBe("constant");
            expect(verdict).toMatchObject({ value: 100 });
        });
    });
});

describe("assessWarrantyFeed", () => {
    it("reports the real fleet: every assessed pack identical, so <80 can never fire", () => {
        // 310 packs in vehicle_state; 297 report exactly 100; 13 report nothing.
        const a = assessWarrantyFeed(297, 13, [100]);
        expect(a).toEqual({
            assessed: 297,
            unassessable: 13,
            constantFeed: true,
            constantValue: 100,
        });
    });

    it("does not call a varying feed constant", () => {
        const a = assessWarrantyFeed(297, 13, [100, 92, 78]);
        expect(a.constantFeed).toBe(false);
        expect(a.constantValue).toBeNull();
    });

    it("keeps unmeasured packs separate from healthy ones", () => {
        // The whole point: 13 packs reporting nothing are not 13 healthy packs.
        const a = assessWarrantyFeed(0, 310, []);
        expect(a.assessed).toBe(0);
        expect(a.unassessable).toBe(310);
        expect(a.constantFeed).toBe(false);
    });

    it("does not claim constancy when nothing was assessed", () => {
        // No packs assessed and no distinct values is silence, not agreement.
        expect(assessWarrantyFeed(0, 5, []).constantFeed).toBe(false);
    });
});
