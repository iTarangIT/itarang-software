import { describe, expect, it } from "vitest";
import { MIN_CYCLE_KM } from "@/lib/telemetry/cycle-distance";
import {
    BASELINE_KM_FRACTION,
    BASELINE_MIN_CYCLES,
    BASELINE_MIN_KM,
    MIN_TRIP_KM,
    OVERLOAD_INDEX_WARN,
    type BaselineInput,
    baselineAhPerKm,
    isOverloaded,
    isoDistanceAh,
    overloadIndex,
} from "@/lib/telemetry/load-math";

/** A calibrated cycle. Named so the exceptions below read as exceptions. */
const cyc = (km: number, ah: number, calibrated = true): BaselineInput => ({ km, ah, calibrated });

describe("baselineAhPerKm — the pack's own best-fifth", () => {
    it("aggregates the best fifth of kilometres, sum-first", () => {
        // 100 km total, so the best fifth is the first 20 km once sorted by Ah/km.
        // A: 5 km @ 0.80 Ah/km, B: 15 km @ 0.90 -> together exactly 20 km, and they stop the walk.
        const cycles = [
            cyc(5, 4), // 0.80 Ah/km — the most efficient
            cyc(15, 13.5), // 0.90
            ...Array.from({ length: 8 }, () => cyc(10, 12)), // 1.20 each
        ];

        const b = baselineAhPerKm(cycles);

        // (4 + 13.5) / (5 + 15) = 0.875 — NOT (0.80 + 0.90)/2 = 0.85.
        expect(b).toEqual({ ahPerKm: 0.875, cycles: 2, km: 20 });
    });

    it("is sum-first, never mean-of-ratios", () => {
        // The same two cycles as above, isolated. A short cycle's ratio carries enormous
        // relative error, so weighting every cycle equally lets a 5 km hop pull the pack's
        // baseline as hard as a 15 km run. Matches avgAhPerKm (battery-queries.ts:868).
        const cycles = [cyc(5, 4), cyc(15, 13.5), ...Array.from({ length: 8 }, () => cyc(10, 12))];

        const meanOfRatios = (4 / 5 + 13.5 / 15) / 2;

        expect(baselineAhPerKm(cycles)?.ahPerKm).not.toBeCloseTo(meanOfRatios, 5);
    });

    it("does not let one lucky short cycle define the baseline", () => {
        // The minimum is whichever cycle's GPS chord over-read the most — a noise statistic,
        // not a best case. 2 km at 0.10 Ah/km is not a physically credible mileage; the
        // km-weighted fifth walks straight past it.
        const cycles = [
            cyc(2, 0.2), // 0.10 Ah/km — absurd, and the min
            ...Array.from({ length: 7 }, () => cyc(20, 20)), // 1.00 Ah/km
        ];

        const b = baselineAhPerKm(cycles);

        // 142 km total, fifth = 28.4 km. Walk: 2, 22, 42 -> the crosser is included, so the
        // baseline is (0.2 + 20 + 20) / (2 + 20 + 20) = 0.957 — an order off the 0.10 minimum.
        expect(b?.ahPerKm).toBeCloseTo(0.957, 3);
        expect(b?.ahPerKm).toBeGreaterThan(0.5);
    });

    it("always includes the crossing cycle, so a single cycle over the fifth still counts", () => {
        // One 60 km cycle is already over the 20% mark on its own. Excluding the crosser
        // would leave the set empty and refuse a baseline the data plainly supports.
        const cycles = [cyc(60, 30), ...Array.from({ length: 7 }, () => cyc(10, 12))];

        const b = baselineAhPerKm(cycles);

        expect(b?.cycles).toBe(1);
        expect(b?.ahPerKm).toBe(0.5);
    });

    it("refuses below the cycle floor — too few cycles is no baseline, not a weak one", () => {
        const cycles = Array.from({ length: BASELINE_MIN_CYCLES - 1 }, () => cyc(50, 50));
        expect(baselineAhPerKm(cycles)).toBeNull();
    });

    it("refuses below the distance floor", () => {
        // Ten cycles, but 20 km between them. The fifth is 4 km — one hop deciding the pack.
        const cycles = Array.from({ length: 10 }, () => cyc(2, 2));
        expect(baselineAhPerKm(cycles)).toBeNull();
    });

    it("excludes uncalibrated cycles — a 27% chord bias is the size of a real overload", () => {
        // 8 calibrated cycles clear the floors. The uncalibrated ones read ~27% short on
        // distance, which inflates their apparent efficiency; letting them near the baseline
        // would set an unreachable best case and make every real cycle look overloaded.
        const cycles = [
            ...Array.from({ length: 8 }, () => cyc(20, 20)),
            cyc(20, 4, false), // 0.20 Ah/km — would dominate the fifth if admitted
            cyc(20, 4, false),
        ];

        const b = baselineAhPerKm(cycles);

        expect(b?.ahPerKm).toBe(1);
        expect(b?.cycles).toBe(2); // 160 km total, fifth = 32 km -> two 20 km cycles
    });

    it("excludes cycles under the distance floor and cycles that drew nothing", () => {
        const cycles = [
            ...Array.from({ length: 8 }, () => cyc(20, 20)),
            cyc(0.5, 1), // parked SOC drain, not a trip
            cyc(20, 0), // no Ah -> no ratio
        ];

        expect(baselineAhPerKm(cycles)?.cycles).toBe(2);
    });

    it("returns null on an empty set rather than throwing", () => {
        expect(baselineAhPerKm([])).toBeNull();
    });
});

describe("overloadIndex", () => {
    it("is 1.0 for a cycle sitting exactly on the baseline", () => {
        expect(overloadIndex(0.875, 0.875)).toBe(1);
    });

    it("rises above 1 for a thirsty cycle and falls below for an efficient one", () => {
        expect(overloadIndex(1.2, 0.8)).toBe(1.5);
        expect(overloadIndex(0.6, 0.8)).toBe(0.75);
    });

    it("declines without a baseline — unknown is not 1.0", () => {
        // A missing baseline must not silently read as "perfectly normal".
        expect(overloadIndex(1.2, null)).toBeNull();
        expect(overloadIndex(null, 0.8)).toBeNull();
        expect(overloadIndex(1.2, 0)).toBeNull();
    });

    it("isOverloaded fires only at or above the warn threshold, and never on unknown", () => {
        expect(isOverloaded(OVERLOAD_INDEX_WARN)).toBe(true);
        expect(isOverloaded(OVERLOAD_INDEX_WARN - 0.01)).toBe(false);
        expect(isOverloaded(null)).toBe(false);
    });
});

describe("isoDistanceAh — the contour that makes the shared axis visible", () => {
    it("inverts mileage into the Ah that would cover a given distance", () => {
        // km = mileage x Ah, so a 30 km cycle at 1.5 km/Ah drew 20 Ah.
        expect(isoDistanceAh(30, 1.5)).toBe(20);
        expect(isoDistanceAh(30, 3)).toBe(10);
    });

    it("declines where the curve is undefined", () => {
        expect(isoDistanceAh(30, 0)).toBeNull();
        expect(isoDistanceAh(30, -1)).toBeNull();
    });
});

/**
 * The chart that does not exist, and the arithmetic proving why.
 *
 * A "mileage vs current" curve was asked for and rejected. This test is the reason, executable:
 * per interval km/Ah = (v.dt) / (I.dt) = v/I, so binning by the *sampled* current and plotting
 * Sum(km)/Sum(Ah) sorts every interval by the very error that sets its y-value.
 *
 * The vehicle below has a PERFECTLY CONSTANT true load — 20 kph, 20 A mean, on every interval.
 * Its true mileage is 1.0 km/Ah everywhere and never moves. Yet because the poller reads current
 * once per ~8.5 minutes while the instantaneous value swings 0-50 A in traffic, the binned curve
 * falls ~9x across the range and looks like a physical law.
 *
 * Binning attacks variance. Variance was never the problem — the estimator is biased, and more
 * data makes the artefact tighter and more convincing, not weaker. A perfect 30 s feed would
 * remove THIS artefact but still leave the curve a hyperbola generated by division (see §1 of
 * the rejection): mileage-vs-current is v(I)/I plotted against I.
 *
 * If someone rebuilds that chart, this test is the tripwire. It imports nothing from production
 * on purpose: it is evidence about arithmetic, not a test of our code.
 */
describe("why mileage-vs-current does not exist (regression: the spurious hyperbola)", () => {
    it("manufactures a >=5x mileage collapse from a vehicle whose mileage never changed", () => {
        const TRUE_SPEED_KPH = 20;
        const TRUE_MEAN_CURRENT_A = 20;
        const DT_S = 510; // the measured p50 gap between stored samples
        const DT_H = DT_S / 3600;

        // Ground truth: every interval covers the same distance and draws the same charge.
        const TRUE_KM_PER_INTERVAL = TRUE_SPEED_KPH * DT_H;
        const TRUE_AH_PER_INTERVAL = TRUE_MEAN_CURRENT_A * DT_H;
        expect(TRUE_KM_PER_INTERVAL / TRUE_AH_PER_INTERVAL).toBeCloseTo(1, 10);

        // The poller catches one instant of a current that swings 0-50 A. The interval's real
        // mean is 20 A regardless of what that single read happened to catch.
        const sampledCurrents = [5, 15, 25, 35, 45];
        const bins = sampledCurrents.map((sampledA) => {
            const kmInBin = TRUE_KM_PER_INTERVAL; // identical — the vehicle did the same thing
            const ahInBin = sampledA * DT_H; // what coulomb counting would record
            return { sampledA, mileage: kmInBin / ahInBin };
        });

        const best = Math.max(...bins.map((b) => b.mileage));
        const worst = Math.min(...bins.map((b) => b.mileage));

        // 4.0 km/Ah in the 5 A bin, 0.44 in the 45 A bin: a 9x spread out of thin air.
        expect(bins[0].mileage).toBeCloseTo(4, 6);
        expect(bins[4].mileage).toBeCloseTo(0.444, 3);
        expect(best / worst).toBeGreaterThanOrEqual(5);

        // ...while the true mileage sat at exactly 1.0 in every one of those bins.
        for (const b of bins) {
            expect(TRUE_KM_PER_INTERVAL / TRUE_AH_PER_INTERVAL).toBeCloseTo(1, 10);
            expect(b.mileage).not.toBeCloseTo(1, 1);
        }
    });

    it("gets WORSE, not better, as more intervals land in each bin", () => {
        // The reassuring instinct is that averaging hundreds of intervals per bin fixes this.
        // It does not: every interval in the 5 A bin is wrong in the SAME direction, so the
        // mean converges on the wrong number and its error bars shrink around it.
        const DT_H = 510 / 3600;
        const binMileage = (sampledA: number, n: number) => {
            const km = n * 20 * DT_H;
            const ah = n * sampledA * DT_H;
            return km / ah;
        };

        for (const n of [1, 10, 1000]) {
            expect(binMileage(5, n)).toBeCloseTo(4, 6); // never moves toward the true 1.0
        }
    });
});

describe("gates are reported, so the UI can say what it filtered", () => {
    it("keeps MIN_TRIP_KM in step with cycle-distance's MIN_CYCLE_KM", () => {
        // load-math cannot import that constant without pulling getIotSql into the client
        // bundle, so the two are declared apart and pinned together here. cycle-distance.ts is
        // the source of truth; if it moves, this fails rather than letting the trip floor and
        // the plotting floor quietly disagree about what counts as a trip.
        expect(MIN_TRIP_KM).toBe(MIN_CYCLE_KM);
    });

    it("exposes the floors it enforced", () => {
        expect(BASELINE_MIN_CYCLES).toBeGreaterThan(0);
        expect(BASELINE_MIN_KM).toBeGreaterThan(0);
        expect(BASELINE_KM_FRACTION).toBeGreaterThan(0);
        expect(BASELINE_KM_FRACTION).toBeLessThanOrEqual(1);
        expect(OVERLOAD_INDEX_WARN).toBeGreaterThan(1);
    });
});
