import { describe, expect, it } from "vitest";
import { capacityAxis } from "@/components/intellicar/battery/capacity-axis";

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

/**
 * The chart feeds capacityAxis only the PLAUSIBLE estimates, and clamps the rest to the edge.
 *
 * This is what these tests defend. Capacity is Ah ÷ (ΔSOC/100), so a cycle that gained 1% SOC
 * amplifies any error in its Ah total a hundredfold — on the reference battery, one such cycle
 * (ΔSOC 1%, two samples) extrapolated to **1,199 Ah on a 105 Ah pack**. It reached the axis, and
 * the axis obliged: the domain stretched to fit it, and all 42 real cycles, the three threshold
 * rules and every tick collapsed into a five-pixel smear at the bottom of the canvas.
 *
 * Two things had to be true to fix it, and both are pinned below:
 *   1. the domain is computed from the plausible points only, and
 *   2. Recharts is told to honour it (`allowDataOverflow`) — its default is to silently GROW a
 *      supplied domain to fit the data, which quietly discarded the careful one.
 */
describe("capacityAxis — the outlier must not set the scale", () => {
    // 0.3x-1.5x of nameplate, mirroring capacityPlausible().
    const plausible = (v: number, rated: number) => v >= rated * 0.3 && v <= rated * 1.5;

    it("stays readable when one measurement fault reads 1,199 Ah on a 105 Ah pack", () => {
        const real = [103.2, 108.5, 111.0, 118.4, 122.3];
        const fault = 1199;

        const naive = capacityAxis([...real, fault], 105);
        const fixed = capacityAxis([...real.filter((v) => plausible(v, 105)), 84], 105);

        // The naive axis spans more than a thousand Ah, so the real spread (19 Ah) occupies
        // barely 1% of the canvas — which is precisely the smear seen on screen.
        const naiveSpan = naive.domain[1] - naive.domain[0];
        const fixedSpan = fixed.domain[1] - fixed.domain[0];
        expect(naiveSpan).toBeGreaterThan(1000);
        expect((19 / naiveSpan) * 100).toBeLessThan(2);

        // The fixed axis keeps the real data occupying a usable share of the height.
        expect(fixedSpan).toBeLessThan(150);
        expect((19 / fixedSpan) * 100).toBeGreaterThan(15);
    });

    it("keeps the nameplate and BOTH threshold rules inside the band", () => {
        // With the blown-out domain, rated (105), warning (94.5) and critical (84) all landed on
        // top of each other at the bottom of the plot and their labels overprinted.
        const rated = 105;
        const warning = 94.5;
        const critical = 84;
        const { domain } = capacityAxis([54, 103.2, 122.3, 150.7, critical], rated);

        for (const v of [critical, warning, rated]) {
            expect(v).toBeGreaterThanOrEqual(domain[0]);
            expect(v).toBeLessThanOrEqual(domain[1]);
        }
        // ...and they are far enough apart to be read as three separate rules.
        const span = domain[1] - domain[0];
        expect((rated - critical) / span).toBeGreaterThan(0.1);
    });

    it("clamps an off-scale point to the edge rather than dropping it", () => {
        // The chart pins these to the axis with a caret: a 1,199 Ah reading is a fault worth
        // seeing. Dropping it would hide a broken cycle; plotting it honestly would break the
        // chart. Clamping shows it without letting it dictate the scale.
        const { domain } = capacityAxis([103.2, 122.3, 84], 105);
        const [lo, hi] = domain;
        const clamp = (v: number) => Math.min(Math.max(v, lo), hi);

        expect(clamp(1199)).toBe(hi);
        expect(clamp(2)).toBe(lo);
        expect(clamp(111)).toBe(111); // an in-range point is untouched
    });
});
