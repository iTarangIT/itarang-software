import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));
const {
    blockATableRows,
    blockAHeadline,
    deltaPct,
    fmtValue,
    pctOfTarget,
    NOT_MEASURED,
    UNMATCHED_REVENUE_LABEL,
    withUnmatchedRevenue,
} = await import("../salesDailyBlockA");

const row = (over: Record<string, unknown> = {}) => ({
    group: "EFFORT" as const,
    label: "Dealers visited",
    kind: "count" as const,
    values: { y: 41, d7: 236, mtd: 812, lm: 745 },
    target: 762,
    ...over,
});

describe("Block A (ID 9)", () => {
    // ID 69 / P1-6: "₹X not matched to a dealer" right under Revenue, hidden at 0.
    it("puts the not-matched line right under Revenue, and hides it when 0", () => {
        const base = [
            row({ group: "OUTCOME", label: "Revenue", kind: "money", values: { y: 100000, d7: 500000, mtd: 1140000, lm: 900000 }, target: null }),
            row({ group: "OUTCOME", label: "KYC submitted", target: null }),
        ];
        const zero = { y: 0, d7: 0, mtd: 0, lm: null };
        expect(withUnmatchedRevenue(base, zero)).toBe(base);
        expect(withUnmatchedRevenue(base, null)).toBe(base);

        const out = withUnmatchedRevenue(base, { y: 0, d7: 25000, mtd: 210000, lm: 0 });
        expect(out.map((r) => r.label)).toEqual(["Revenue", UNMATCHED_REVENUE_LABEL, "KYC submitted"]);
        const table = blockATableRows(out);
        expect(table[2]).toEqual([UNMATCHED_REVENUE_LABEL, "₹0", "₹25,000", "₹2.1 L", "—", "—", "₹0", "—"]);
    });

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

    // ID 59: "Dealers visited" shows distinct dealers company-wide; its target
    // is the sum of personal targets, each counting that person's own dealers.
    it("% of target uses the target's own basis when it differs from the figure shown", () => {
        const out = blockATableRows([row({ targetBasisMtd: 830 })]);
        // The cell still shows 812; 830 / 762 = 109%.
        expect(out[1]).toEqual(["Dealers visited", "41", "236", "812", "762", "109%", "745", "+9%"]);
        expect(blockATableRows([row({ targetBasisMtd: null })])[1][5]).toBe("107%");
        // Shown 500 would be 66%; on the target's basis (560) it is 73% — still behind.
        const h = blockAHeadline([row({ values: { y: 1, d7: 5, mtd: 500, lm: 400 }, target: 762, targetBasisMtd: 560 })]);
        expect(h).toMatch(/dealers visited at 73%/);
    });

    // ID 59: a period with no measured call answers NULL, shown as such — not 0.
    it("a metric that is not measurable in any period reads Not measured yet, not 0", () => {
        const out = blockATableRows([
            row({ label: "Engaged calls", values: { y: null, d7: null, mtd: null, lm: null }, target: null }),
            row({ label: "Engaged calls", values: { y: null, d7: 3, mtd: 7, lm: null }, target: null }),
        ]);
        expect(out[1]).toEqual(["Engaged calls", NOT_MEASURED, "", "", "", "", "", ""]);
        expect(out[2].slice(0, 4)).toEqual(["Engaged calls", NOT_MEASURED, "3", "7"]);
    });

    it("headline names what is behind target", () => {
        const h = blockAHeadline([row({ label: "New dealers visited", values: { y: 12, d7: 71, mtd: 238, lm: 262 }, target: 305 })]);
        expect(h).toMatch(/new dealers visited at 78%/);
    });
});
