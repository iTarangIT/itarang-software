import { describe, expect, it } from "vitest";
import {
    CAPACITY_SOC_THRESHOLD,
    COVERAGE_TRUST_GAP_S,
    MIN_COVERAGE_PCT,
    ahIncrement,
    avgSamplingIntervalS,
    capacityConfidence,
    capacityPlausible,
    extrapolateCapacity,
} from "@/lib/telemetry/charging-math";
import EXCEL_CYCLE from "./fixtures/excel-charging-cycle-1.json";

describe("ahIncrement", () => {
    it("integrates the mean of the interval's two currents over its real duration", () => {
        // Steady 20 A for an hour → 20 Ah.
        expect(ahIncrement({ dt_s: 3600, pack_current: 20, prev_current: 20 })).toBe(20);
        // Ramping 10 A → 30 A over an hour: the trapezoid takes the mean, 20 A.
        expect(ahIncrement({ dt_s: 3600, pack_current: 30, prev_current: 10 })).toBe(20);
        expect(ahIncrement({ dt_s: 1800, pack_current: 20, prev_current: 20 })).toBe(10);
    });

    it("uses magnitudes, since the BMS reports pack current unsigned", () => {
        expect(ahIncrement({ dt_s: 3600, pack_current: -20, prev_current: -20 })).toBe(20);
    });

    it("accrues on a flat-SOC step, because current flows between whole-percent ticks", () => {
        // The bug this replaces: gating on dsoc > 0 dropped these rows entirely.
        expect(ahIncrement({ dt_s: 3600, pack_current: 20, prev_current: 20 })).toBe(20);
    });

    it("accrues nothing across an interior pause, without needing to be skipped", () => {
        expect(ahIncrement({ dt_s: 3600, pack_current: 0, prev_current: 0 })).toBe(0);
    });

    it("falls back to a rectangle when there is no previous reading", () => {
        expect(ahIncrement({ dt_s: 3600, pack_current: 20, prev_current: null })).toBe(20);
    });

    it("contributes nothing when the current or the interval is missing or empty", () => {
        expect(ahIncrement({ dt_s: 3600, pack_current: null, prev_current: 20 })).toBe(0);
        expect(ahIncrement({ dt_s: null, pack_current: 20, prev_current: 20 })).toBe(0);
        // Duplicate timestamps used to land here — dt 0 means no elapsed time, no charge.
        expect(ahIncrement({ dt_s: 0, pack_current: 20, prev_current: 20 })).toBe(0);
    });
});

describe("extrapolateCapacity", () => {
    it("extrapolates a well-covered, large swing to 100%", () => {
        // 78.2 Ah added over 74% of the pack → 105.7 Ah full capacity.
        expect(extrapolateCapacity(78.2, 74)).toBe(105.7);
    });

    it("estimates at exactly the swing threshold", () => {
        expect(CAPACITY_SOC_THRESHOLD).toBe(20);
        expect(extrapolateCapacity(21, 20)).toBe(105);
    });

    it("estimates a small top-up rather than withholding the number", () => {
        // This REVERSES the old behaviour, deliberately. Dividing by ΔSOC/100 multiplies any
        // error in the Ah total by 100/ΔSOC, so a small swing is genuinely untrustworthy — but
        // the answer to an untrustworthy number is a confidence grade, not silence. Withholding
        // it told the reader nothing; the number plus its grade tells them what to do with it.
        expect(extrapolateCapacity(5.2, 5)).toBe(104);
        expect(extrapolateCapacity(52.5, 19.9)).toBe(263.8);

        // ...and both are graded honestly.
        expect(capacityConfidence(5, 100, 30)).toBe("low");
        expect(capacityConfidence(19.9, 100, 30)).toBe("medium");
    });

    it("refuses only when the arithmetic itself is impossible", () => {
        // A non-positive swing has no capacity to extrapolate. That is the ONLY refusal left.
        expect(extrapolateCapacity(10, 0)).toBeNull();
        expect(extrapolateCapacity(10, -5)).toBeNull();
        expect(extrapolateCapacity(10, null)).toBeNull();
    });

    it("keeps a sub-50% cycle, which the old threshold threw away", () => {
        // The regression this change exists to prevent: a 37% swing is a perfectly good
        // charge. Under the old 50% gate only 2 of 34 detected cycles survived.
        expect(extrapolateCapacity(36.76, 37)).toBe(99.4);
        expect(extrapolateCapacity(23.17, 22)).toBe(105.3);
    });

    it("grades a cycle integrated across too little real data, rather than deleting it", () => {
        // The estimate now stands whatever the coverage — coverage decides how far to TRUST it,
        // not whether it exists. A 40 Ah reading on a 105 Ah pack is still wrong; the difference
        // is that it now arrives labelled low instead of vanishing without explanation.
        expect(MIN_COVERAGE_PCT).toBe(15);

        // The arithmetic does not know about coverage, and must not: the SAME swing and the SAME
        // Ah give the SAME number every time. Only the grade beside it moves.
        expect(extrapolateCapacity(78.2, 74)).toBe(105.7);
        expect(capacityConfidence(74, 90, 30)).toBe("high");
        expect(capacityConfidence(74, 10, 30)).toBe("medium");
        expect(capacityConfidence(74, 3, 30)).toBe("low");
        // Unknown coverage is not evidence of good coverage.
        expect(capacityConfidence(74, null, 30)).toBe("low");
    });
});

describe("capacityConfidence — the grade that replaced the gates", () => {
    it("needs the swing, the coverage AND the samples to call an estimate solid", () => {
        // A cycle is only as good as its worst evidence: each of the three independently wrecks
        // the extrapolation, so `high` requires all three.
        expect(capacityConfidence(74, 90, 30)).toBe("high");
        expect(capacityConfidence(2, 90, 30)).toBe("low"); // swing amplifies error x50
        expect(capacityConfidence(74, 1, 30)).toBe("low"); // current was interpolated, not seen
        // Two samples describe ONE interval — a straight line through an entire charge. A perfect
        // swing and perfect coverage cannot rescue an integral that has nothing to integrate.
        expect(capacityConfidence(74, 90, 2)).toBe("low");
        expect(capacityConfidence(74, 90, 3)).toBe("medium");
    });

    it("never returns high for a swing below the amplification threshold", () => {
        expect(CAPACITY_SOC_THRESHOLD).toBe(20);
        expect(capacityConfidence(CAPACITY_SOC_THRESHOLD - 0.1, 100, 50)).not.toBe("high");
        expect(capacityConfidence(CAPACITY_SOC_THRESHOLD, 100, 50)).toBe("high");
    });

    it("is low when there is nothing to extrapolate at all", () => {
        expect(capacityConfidence(0, 100, 50)).toBe("low");
        expect(capacityConfidence(null, 100, 50)).toBe("low");
    });
});

describe("avgSamplingIntervalS", () => {
    it("divides by n-1 intervals, not n samples", () => {
        // 5 samples bound FOUR intervals. Dividing by 5 understates the spacing by a whole
        // interval — a 25% error in the very number a reader uses to judge every other number.
        expect(avgSamplingIntervalS(4000, 5)).toBe(1000);
        expect(avgSamplingIntervalS(3600, 2)).toBe(3600);
    });

    it("declines when there is no interval to measure", () => {
        // One sample bounds no interval at all — there is nothing to average.
        expect(avgSamplingIntervalS(3600, 1)).toBeNull();
        expect(avgSamplingIntervalS(0, 10)).toBeNull();
        expect(avgSamplingIntervalS(null, 10)).toBeNull();
    });
});

describe("capacityPlausible", () => {
    it("accepts an estimate near the nameplate", () => {
        expect(capacityPlausible(94, 105)).toBe(true);
        expect(capacityPlausible(105, 105)).toBe(true);
    });

    it("rejects the spreadsheet's 19.26 Ah against a 105 Ah nameplate", () => {
        // The check that would have caught the vendor sheet's under-integration.
        expect(capacityPlausible(19.26, 105)).toBe(false);
    });

    it("rejects an estimate implausibly above the nameplate", () => {
        expect(capacityPlausible(200, 105)).toBe(false);
    });

    it("treats an unknown nameplate or a declined estimate as no fault", () => {
        expect(capacityPlausible(19.26, null)).toBe(true);
        expect(capacityPlausible(null, 105)).toBe(true);
    });
});

/**
 * The reference cycle from `docs/intellicar/CAN Data.xlsx` — battery
 * TK-51105-02DZ-213416 charging 24% → 100% on 2026-06-11.
 *
 * The spreadsheet computes 14.64 Ah → **19.26 Ah** capacity, and that figure is
 * wrong: it multiplies each sample's current by a *nominal* 30 s packet interval
 * carried in its own column, which sums to 3,060 s of a 16,380 s charge. It
 * therefore integrates 18.7% of the elapsed time. The battery's own BMS reports a
 * 105 Ah nameplate at SOH 100%, so a 19.26 Ah pack is physically impossible.
 *
 * These tests pin the corrected result and pin the bug, so nobody "fixes" our
 * numbers back to match the sheet.
 */
describe("the reference cycle from CAN Data.xlsx", () => {
    const samples = EXCEL_CYCLE.rows.map((r) => ({
        t: new Date(r.time).getTime() / 1000,
        soc: r.soc,
        current: r.current,
        vendorDt: r.vendor_dt_s,
    }));

    /** Replays what cycleCTEs does in SQL: real elapsed dt, trapezoid, every row. */
    const totalAh = samples.reduce((sum, s, i) => {
        if (i === 0) return sum; // first interval reaches into the idle time before the charge
        return (
            sum +
            ahIncrement({
                dt_s: s.t - samples[i - 1].t,
                pack_current: s.current,
                prev_current: samples[i - 1].current,
            })
        );
    }, 0);

    const socChange = samples[samples.length - 1].soc - samples[0].soc;
    const durationS = samples[samples.length - 1].t - samples[0].t;
    const coveredS = samples.reduce((sum, s, i) => {
        if (i === 0) return sum;
        const dt = s.t - samples[i - 1].t;
        return dt <= COVERAGE_TRUST_GAP_S ? sum + dt : sum;
    }, 0);
    const coveragePct = (coveredS / durationS) * 100;

    it("spans 24% → 100% over 4h33m", () => {
        expect(samples[0].soc).toBe(24);
        expect(samples[samples.length - 1].soc).toBe(100);
        expect(socChange).toBe(76);
        expect(Math.round(durationS)).toBe(16380);
    });

    it("shows the vendor dt column accounting for only ~19% of the charge", () => {
        // The root cause, stated as an assertion: this column is a nominal packet
        // interval, not the spacing between the rows in the dump.
        const vendorTotal = samples.slice(1).reduce((s, r) => s + r.vendorDt, 0);
        expect(vendorTotal).toBe(3030);
        expect(vendorTotal / durationS).toBeLessThan(0.2);
    });

    it("is fully covered, so its capacity may be extrapolated", () => {
        expect(coveragePct).toBe(100);
    });

    it("charges 71.41 Ah when integrated over real elapsed time", () => {
        expect(totalAh).toBeCloseTo(71.41, 2);
    });

    it("estimates 94.0 Ah — consistent with the 105 Ah nameplate, not the sheet's 19.26", () => {
        const capacity = extrapolateCapacity(totalAh, socChange);
        expect(capacity).toBe(94);
        expect(capacity).not.toBe(19.26);
        expect(capacityPlausible(capacity, 105)).toBe(true);
    });

    it("reproduces the spreadsheet's wrong answer only if the nominal dt is used", () => {
        // Proof that we understand the sheet rather than merely disagreeing with it:
        // its own formula, =current x nominal_dt / 3600, reproduced exactly.
        const vendorAh = samples.reduce(
            (sum, s) => sum + (s.current * s.vendorDt) / 3600,
            0,
        );
        expect(vendorAh).toBeCloseTo(14.6367, 3);
        expect(vendorAh / (socChange / 100)).toBeCloseTo(19.26, 2);
        // And it is not physically credible against the nameplate.
        expect(capacityPlausible(19.26, 105)).toBe(false);
    });
});
