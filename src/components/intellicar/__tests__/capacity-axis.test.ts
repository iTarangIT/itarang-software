import { describe, expect, it } from "vitest";
import { capacityAxis } from "@/components/intellicar/TripAnalytics";

describe("capacityAxis", () => {
    it("frames the data instead of the origin", () => {
        // The regression this exists to prevent: a 0-based axis on capacities that all
        // sit near 100 Ah squashed every point into the top fifth of the canvas, which
        // hid the movement the chart exists to show.
        const { domain, ticks } = capacityAxis([75.6, 99.2, 113.3, 126.4], 105);
        expect(domain[0]).toBeGreaterThan(0);
        expect(domain).toEqual([60, 140]);
        expect(ticks).toEqual([60, 80, 100, 120, 140]);
    });

    it("keeps every point and the nameplate inside the band", () => {
        const values = [75.6, 91.1, 99.2, 105.3, 126.4];
        const { domain } = capacityAxis(values, 105);
        for (const v of [...values, 105]) {
            expect(v).toBeGreaterThanOrEqual(domain[0]);
            expect(v).toBeLessThanOrEqual(domain[1]);
        }
    });

    it("snaps to round ticks rather than raw data extremes", () => {
        // Nobody should have to decode 126.4 off an axis.
        const { ticks } = capacityAxis([75.6, 126.4], 105);
        expect(ticks.every((t) => Number.isInteger(t) && t % 10 === 0)).toBe(true);
    });

    it("still gives a usable band for a single point", () => {
        const { domain, ticks } = capacityAxis([99.2], 105);
        expect(domain[0]).toBeLessThan(99.2);
        expect(domain[1]).toBeGreaterThan(105);
        expect(ticks.length).toBeGreaterThanOrEqual(2);
    });

    it("never drops below zero, even for an implausibly small capacity", () => {
        const { domain } = capacityAxis([2], null);
        expect(domain[0]).toBe(0);
    });

    it("falls back to a sane axis with no data at all", () => {
        expect(capacityAxis([], null).domain).toEqual([0, 100]);
    });
});
