// Tests for the sales-target rules (review R-17, sheet 8, Requirement #15).

import { describe, expect, it } from "vitest";
import {
    metricsForRole,
    monthEnd,
    progress,
    rag,
    validateAddon,
    validateKycPair,
    workingDaysBetween,
} from "@/lib/targets/rules";

describe("workingDaysBetween", () => {
    it("counts Mon–Sat and skips Sundays and holidays", () => {
        // September 2026: 30 days, Sundays on 6, 13, 20, 27 → 26 working days.
        expect(workingDaysBetween("2026-09-01", "2026-09-30", new Set())).toBe(26);
        expect(workingDaysBetween("2026-09-01", "2026-09-30", new Set(["2026-09-17"]))).toBe(25);
    });

    it("is zero for an empty range", () => {
        expect(workingDaysBetween("2026-09-10", "2026-09-09", new Set())).toBe(0);
    });
});

describe("monthEnd", () => {
    it("handles 30-, 31-day and February months", () => {
        expect(monthEnd("2026-09-01")).toBe("2026-09-30");
        expect(monthEnd("2026-10-01")).toBe("2026-10-31");
        expect(monthEnd("2028-02-01")).toBe("2028-02-29");
    });
});

describe("rules", () => {
    it("admin can add, never reduce", () => {
        expect(validateAddon(5)).toBeNull();
        expect(validateAddon(0)).toBeNull();
        expect(validateAddon(-1)).toMatch(/never reduce/);
    });

    it("KYC disbursed may not exceed KYC submitted", () => {
        expect(validateKycPair(10, 8)).toBeNull();
        expect(validateKycPair(10, 11)).toMatch(/cannot be more/);
        expect(validateKycPair(null, 11)).toBeNull();
    });

    it("gives each role its #15 metrics", () => {
        expect(metricsForRole("asm")).toContain("batteries_sold");
        expect(metricsForRole("inside_sales_rep")).toEqual(["calls_per_day", "hot_to_ground"]);
        expect(metricsForRole("ceo")).toEqual([]);
    });

    it("RAG bands", () => {
        expect(rag(100)).toBe("green");
        expect(rag(80)).toBe("amber");
        expect(rag(79)).toBe("red");
        expect(rag(null)).toBeNull();
    });
});

describe("progress", () => {
    it("pro-rates a monthly target by working days (sheet 8 §B)", () => {
        // 26 working days, 17 elapsed, target 26 → MTD target 17.
        const p = progress({ metric: "dealer_visits", monthly: 26, actual: 17, workingDaysTotal: 26, workingDaysElapsed: 17 });
        expect(p.mtd_target).toBe(17);
        expect(p.pct_of_mtd).toBe(100);
        expect(p.remaining).toBe(9);
        expect(p.required_per_day).toBe(1);
        expect(p.rag).toBe("green");
    });

    it("compares a per-day metric to its rate, not pro-rata", () => {
        const p = progress({ metric: "calls_per_day", monthly: 40, actual: 30, workingDaysTotal: 26, workingDaysElapsed: 10 });
        expect(p.mtd_target).toBe(40);
        expect(p.pct_of_mtd).toBe(75);
        expect(p.rag).toBe("red");
        expect(p.remaining).toBeNull();
    });

    it("leaves an unmeasurable metric without a RAG", () => {
        const p = progress({ metric: "kyc_disbursed", monthly: 5, actual: null, workingDaysTotal: 26, workingDaysElapsed: 10 });
        expect(p.rag).toBeNull();
        expect(p.pct_of_mtd).toBeNull();
    });
});
