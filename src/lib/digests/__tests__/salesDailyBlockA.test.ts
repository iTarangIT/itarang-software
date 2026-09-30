import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));
const { blockATableRows, blockAHeadline, deltaPct, fmtValue, pctOfTarget, NOT_MEASURED } = await import("../salesDailyBlockA");

const row = (over: Record<string, unknown> = {}) => ({
    group: "EFFORT" as const,
    label: "Dealers visited",
    kind: "count" as const,
    values: { y: 41, d7: 236, mtd: 812, lm: 745 },
    target: 762,
    ...over,
});

describe("Block A (ID 9)", () => {
    it("formats money in lakh / crore", () => {
        expect(fmtValue(1140000, "money")).toBe("₹11.4 L");
        expect(fmtValue(27100000, "money")).toBe("₹2.71 Cr");
        expect(fmtValue(null, "count")).toBe(NOT_MEASURED);
    });

    it("% of target and Δ MTD", () => {
        expect(pctOfTarget(812, 762)).toBe(107);
        expect(pctOfTarget(812, null)).toBeNull();
        expect(deltaPct(238, 262)).toBe(-9);
        expect(deltaPct(10, 0)).toBeNull();
    });

    it("group header rows, then metrics; unmeasured rows read Not measured yet", () => {
        const out = blockATableRows([
            row(),
            row({ group: "DISCIPLINE", label: "Time limits missed", values: { y: null, d7: null, mtd: null, lm: null }, target: null }),
        ]);
        expect(out[0][0]).toBe("EFFORT");
        expect(out[1]).toEqual(["Dealers visited", "41", "236", "812", "762", "107%", "745", "+9%"]);
        expect(out[2][0]).toBe("DISCIPLINE");
        expect(out[3]).toEqual(["Time limits missed", NOT_MEASURED, "", "", "", "", "", ""]);
    });

    it("headline names what is behind target", () => {
        const h = blockAHeadline([row({ label: "New dealers visited", values: { y: 12, d7: 71, mtd: 238, lm: 262 }, target: 305 })]);
        expect(h).toMatch(/new dealers visited at 78%/);
    });
});
