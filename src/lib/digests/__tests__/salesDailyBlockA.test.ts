import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));
const {
    blockATableRows,
    blockAHeadline,
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
    values: { y: 41, prev: 38, wk: 35, mtd: 812 },
    target: 762,
    ...over,
});

describe("Block A (ID 9)", () => {
    // ID 69 / P1-6: "₹X not matched to a dealer" right under Revenue, hidden at 0.
    it("puts the not-matched line right under Revenue, and hides it when 0", () => {
        const base = [
            row({ group: "OUTCOME", label: "Revenue", kind: "money", values: { y: 100000, prev: 50000, wk: 90000, mtd: 1140000 }, target: null }),
            row({ group: "OUTCOME", label: "KYC submitted", target: null }),
        ];
        const zero = { y: 0, prev: 0, wk: null, mtd: 0 };
        expect(withUnmatchedRevenue(base, zero)).toBe(base);
        expect(withUnmatchedRevenue(base, null)).toBe(base);

        const out = withUnmatchedRevenue(base, { y: 0, prev: 25000, wk: 0, mtd: 210000 });
        expect(out.map((r) => r.label)).toEqual(["Revenue", UNMATCHED_REVENUE_LABEL, "KYC submitted"]);
        const table = blockATableRows(out);
        expect(table[2]).toEqual([UNMATCHED_REVENUE_LABEL, "₹0", "₹25,000", "₹0", "₹2.1 L", "—", "—"]);
    });

    it("formats money in lakh / crore", () => {
        expect(fmtValue(1140000, "money")).toBe("₹11.4 L");
        expect(fmtValue(27100000, "money")).toBe("₹2.71 Cr");
        expect(fmtValue(null, "count")).toBe(NOT_MEASURED);
    });

    it("% of target", () => {
        expect(pctOfTarget(812, 762)).toBe(107);
        expect(pctOfTarget(812, null)).toBeNull();
    });

    // ID 188: Yesterday · Day before · Same day last week · MTD · MTD target · % of target.
    it("ID 188: the Sales Head's columns, and n/t for a comparison day not tracked", async () => {
        const { BLOCK_A_COLUMNS, BLOCK_A_PCT_COLUMN } = await import("../salesDailyBlockA");
        expect(BLOCK_A_COLUMNS).toEqual(["Metric", "Yesterday", "Day before", "Same day last week", "MTD", "MTD target", "% of target"]);
        expect(BLOCK_A_PCT_COLUMN).toBe(6);
        const out = blockATableRows([row({ values: { y: 5, prev: null, wk: 2, mtd: 40 }, target: null })]);
        expect(out[1]).toEqual(["Dealers visited", "5", "n/t", "2", "40", "—", "—"]);
    });

    it("group header rows, then metrics; unmeasured rows read Not measured yet", () => {
        const out = blockATableRows([
            row(),
            row({ group: "DISCIPLINE", label: "Time limits missed", values: { y: null, prev: null, wk: null, mtd: null }, target: null }),
        ]);
        expect(out[0]).toEqual(["EFFORT", "", "", "", "", "", ""]);
        expect(out[1]).toEqual(["Dealers visited", "41", "38", "35", "812", "762", "107%"]);
        expect(out[2][0]).toBe("DISCIPLINE");
        expect(out[3]).toEqual(["Time limits missed", NOT_MEASURED, "", "", "", "", ""]);
    });

    // ID 59: "Dealers visited" shows distinct dealers company-wide; its target
    // is the sum of personal targets, each counting that person's own dealers.
    it("% of target uses the target's own basis when it differs from the figure shown", () => {
        const out = blockATableRows([row({ targetBasisMtd: 830 })]);
        // The cell still shows 812; 830 / 762 = 109%.
        expect(out[1]).toEqual(["Dealers visited", "41", "38", "35", "812", "762", "109%"]);
        expect(blockATableRows([row({ targetBasisMtd: null })])[1][6]).toBe("107%");
        // Shown 500 would be 66%; on the target's basis (560) it is 73% — still behind.
        const h = blockAHeadline([row({ values: { y: 1, prev: 2, wk: 3, mtd: 500 }, target: 762, targetBasisMtd: 560 })]);
        expect(h).toMatch(/dealers visited at 73%/);
    });

    // A period whose query answered NULL (e.g. a DB without E-314) is shown as such — not 0.
    it("a metric that is not measurable in any period reads Not measured yet, not 0", () => {
        const out = blockATableRows([
            row({ label: "Sales-ready", values: { y: null, prev: null, wk: null, mtd: null }, target: null }),
            row({ label: "Sales-ready", values: { y: null, prev: 3, wk: null, mtd: 7 }, target: null }),
        ]);
        expect(out[1]).toEqual(["Sales-ready", NOT_MEASURED, "", "", "", "", ""]);
        expect(out[2].slice(0, 5)).toEqual(["Sales-ready", NOT_MEASURED, "3", "n/t", "7"]);
    });

    it("headline names what is behind target", () => {
        const h = blockAHeadline([row({ label: "New dealers visited", values: { y: 12, prev: 9, wk: 10, mtd: 238 }, target: 305 })]);
        expect(h).toMatch(/new dealers visited at 78%/);
    });

    // IDs 70 / 147: "Batteries sold" reads like the CEO tile (batteryReading).
    it("Batteries sold: '—' when no invoice has item lines, 'N+' and an 'at least' note when only some do", async () => {
        const { blockARowNotes, readingNote } = await import("../salesDailyBlockA");
        const rd = (state: "unknown" | "partial" | "complete", value: number | null, invoices: number, with_lines: number) => ({
            state,
            value,
            invoices,
            with_lines,
        });
        const readings = { y: rd("unknown", null, 3, 0), prev: rd("partial", 12, 9, 4), wk: rd("complete", 30, 18, 18), mtd: rd("partial", 40, 20, 15) };
        const bat = { ...row({ group: "OUTCOME", label: "Batteries sold", values: { y: 0, prev: 12, wk: 30, mtd: 40 }, target: 50 }), readings };
        const [, cells] = blockATableRows([bat]);
        expect(cells[1]).toBe("—");
        expect(cells[2]).toBe("12+");
        expect(cells[3]).toBe("30");
        expect(cells[4]).toBe("40+");
        expect(blockARowNotes([bat])[1]).toBe("Invoices matched to a dealer · At least — 15 of 20 invoices have item lines (month to date)");

        const unknownMtd = { ...bat, readings: { ...readings, mtd: rd("unknown", null, 20, 0) } };
        const [, u] = blockATableRows([unknownMtd]);
        expect(u[4]).toBe("—");
        expect(u[6]).toBe("—"); // no % of target from a false 0
        expect(readingNote(null, unknownMtd.readings)).toBe("No item lines read on the 20 invoices month to date");
        expect(readingNote("x", undefined)).toBe("x");
    });
});
