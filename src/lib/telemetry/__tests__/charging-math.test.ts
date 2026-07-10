import { describe, expect, it } from "vitest";
import {
    CAPACITY_SOC_THRESHOLD,
    ahIncrement,
    extrapolateCapacity,
} from "@/lib/telemetry/charging-math";

describe("extrapolateCapacity", () => {
    it("extrapolates a large swing to 100%", () => {
        // 78.2 Ah added over 74% of the pack → 105.7 Ah full capacity.
        expect(extrapolateCapacity(78.2, 74)).toBe(105.7);
    });

    it("estimates at exactly the 50% threshold", () => {
        expect(CAPACITY_SOC_THRESHOLD).toBe(50);
        expect(extrapolateCapacity(52.5, 50)).toBe(105);
    });

    it("declines to estimate just below the threshold", () => {
        expect(extrapolateCapacity(52.5, 49.9)).toBeNull();
    });

    it("declines to estimate a small top-up rather than amplifying its noise", () => {
        // 5% swing would be stretched x20 — the whole reason for the gate.
        expect(extrapolateCapacity(5.2, 5)).toBeNull();
    });

    it("declines to estimate when no step carried a current reading", () => {
        expect(extrapolateCapacity(0, null)).toBeNull();
    });

    it("rounds to one decimal place", () => {
        // 64.3 / 0.61 = 105.409836… → 105.4
        expect(extrapolateCapacity(64.3, 61)).toBe(105.4);
    });
});

describe("ahIncrement", () => {
    it("integrates |current| over the interval in hours", () => {
        expect(ahIncrement({ dsoc: 1, dt_s: 3600, pack_current: 20 })).toBe(20);
        expect(ahIncrement({ dsoc: 1, dt_s: 1800, pack_current: 20 })).toBe(10);
    });

    it("uses the magnitude, since the pack-current sign convention varies", () => {
        expect(ahIncrement({ dsoc: 1, dt_s: 3600, pack_current: -20 })).toBe(20);
    });

    it("contributes nothing when SOC did not rise", () => {
        expect(ahIncrement({ dsoc: 0, dt_s: 3600, pack_current: 20 })).toBe(0);
        expect(ahIncrement({ dsoc: -2, dt_s: 3600, pack_current: 20 })).toBe(0);
    });

    it("contributes nothing when current or the interval is missing", () => {
        expect(ahIncrement({ dsoc: 1, dt_s: 3600, pack_current: null })).toBe(0);
        expect(ahIncrement({ dsoc: 1, dt_s: null, pack_current: 20 })).toBe(0);
        expect(ahIncrement({ dsoc: null, dt_s: 3600, pack_current: 20 })).toBe(0);
    });
});
