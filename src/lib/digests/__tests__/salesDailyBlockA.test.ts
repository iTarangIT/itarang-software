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
    values: { y: 41, prev: 38, wk: 35, d7: 240, mtd: 812, lm: 700 },
    target: 762,
    ...over,
});

describe("Block A (ID 9)", () => {
    // ID 69 / P1-6: "₹X not matched to a dealer" right under Revenue, hidden at 0.
    it("puts the not-matched line right under Revenue, and hides it when 0", () => {
        const base = [
            row({ group: "OUTCOME", label: "Revenue", kind: "money", values: { y: 100000, prev: 50000, wk: 90000, d7: 400000, mtd: 1140000, lm: 1000000 }, target: null }),
            row({ group: "OUTCOME", label: "KYC submitted", target: null }),
        ];
        const zero = { y: 0, prev: 0, wk: null, d7: 0, mtd: 0, lm: null };
        expect(withUnmatchedRevenue(base, zero)).toBe(base);
        expect(withUnmatchedRevenue(base, null)).toBe(base);

        const out = withUnmatchedRevenue(base, { y: 0, prev: 25000, wk: 0, d7: 25000, mtd: 210000, lm: null });
        expect(out.map((r) => r.label)).toEqual(["Revenue", UNMATCHED_REVENUE_LABEL, "KYC submitted"]);
        const table = blockATableRows(out);
        expect(table[2]).toEqual([UNMATCHED_REVENUE_LABEL, "₹0", "₹25,000", "₹0", "₹25,000", "₹2.1 L", "—", "—", "n/t", "—"]);
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

    // ID 188: Yesterday · Day before · Same day last week, and (30 Oct) Last 7 days,
    // Same period last month and Δ MTD back beside them.
    it("ID 188: the Sales Head's columns plus last 7 days, last month and Δ; n/t for a period not tracked", async () => {
        const { BLOCK_A_COLUMNS, BLOCK_A_PCT_COLUMN } = await import("../salesDailyBlockA");
        expect(BLOCK_A_COLUMNS).toEqual([
            "Metric",
            "Yesterday",
            "Day before",
            "Same day last week",
            "Last 7 days",
            "MTD",
            "MTD target",
            "% of target",
            "Same period last month",
            "Δ MTD",
        ]);
        expect(BLOCK_A_PCT_COLUMN).toBe(7);
        const out = blockATableRows([row({ values: { y: 5, prev: null, wk: 2, d7: 12, mtd: 40, lm: null }, target: null })]);
        expect(out[1]).toEqual(["Dealers visited", "5", "n/t", "2", "12", "40", "—", "—", "n/t", "—"]);
    });

    it("ID 188: Δ MTD against the same period last month", async () => {
        const { deltaPct } = await import("../salesDailyBlockA");
        expect(deltaPct(812, 700)).toBe(16);
        expect(deltaPct(600, 700)).toBe(-14);
        expect(deltaPct(5, 0)).toBeNull();
        expect(deltaPct(null, 700)).toBeNull();
        expect(blockATableRows([row()])[1][9]).toBe("+16%");
        expect(blockATableRows([row({ values: { y: 1, prev: 1, wk: 1, d7: 5, mtd: 600, lm: 700 } })])[1][9]).toBe("−14%");
    });

    it("group header rows, then metrics; unmeasured rows read Not measured yet", () => {
        const out = blockATableRows([
            row(),
            row({ group: "DISCIPLINE", label: "Time limits missed", values: { y: null, prev: null, wk: null, d7: null, mtd: null, lm: null }, target: null }),
        ]);
        expect(out[0]).toEqual(["EFFORT", "", "", "", "", "", "", "", "", ""]);
        expect(out[1]).toEqual(["Dealers visited", "41", "38", "35", "240", "812", "762", "107%", "700", "+16%"]);
        expect(out[2][0]).toBe("DISCIPLINE");
        expect(out[3]).toEqual(["Time limits missed", NOT_MEASURED, "", "", "", "", "", "", "", ""]);
    });

    // ID 59: "Dealers visited" shows distinct dealers company-wide; its target
    // is the sum of personal targets, each counting that person's own dealers.
    it("% of target uses the target's own basis when it differs from the figure shown", () => {
        const out = blockATableRows([row({ targetBasisMtd: 830 })]);
        // The cell still shows 812; 830 / 762 = 109%.
        expect(out[1]).toEqual(["Dealers visited", "41", "38", "35", "240", "812", "762", "109%", "700", "+16%"]);
        expect(blockATableRows([row({ targetBasisMtd: null })])[1][7]).toBe("107%");
        // Shown 500 would be 66%; on the target's basis (560) it is 73% — still behind.
        const h = blockAHeadline([row({ values: { y: 1, prev: 2, wk: 3, d7: 9, mtd: 500, lm: null }, target: 762, targetBasisMtd: 560 })]);
        expect(h).toMatch(/dealers visited at 73%/);
    });

    // A period whose query answered NULL (e.g. a DB without E-314) is shown as such — not 0.
    it("a metric that is not measurable in any period reads Not measured yet, not 0", () => {
        const out = blockATableRows([
            row({ label: "Sales-ready", values: { y: null, prev: null, wk: null, d7: null, mtd: null, lm: null }, target: null }),
            row({ label: "Sales-ready", values: { y: null, prev: 3, wk: null, d7: 5, mtd: 7, lm: null }, target: null }),
        ]);
        expect(out[1]).toEqual(["Sales-ready", NOT_MEASURED, "", "", "", "", "", "", "", ""]);
        expect(out[2].slice(0, 6)).toEqual(["Sales-ready", NOT_MEASURED, "3", "n/t", "5", "7"]);
    });

    it("headline names what is behind target", () => {
        const h = blockAHeadline([row({ label: "New dealers visited", values: { y: 12, prev: 9, wk: 10, d7: 60, mtd: 238, lm: 200 }, target: 305 })]);
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
        const readings = {
            y: rd("unknown", null, 3, 0),
            prev: rd("partial", 12, 9, 4),
            wk: rd("complete", 30, 18, 18),
            d7: rd("partial", 25, 12, 8),
            mtd: rd("partial", 40, 20, 15),
            lm: rd("complete", 35, 22, 22),
        };
        const bat = {
            ...row({ group: "OUTCOME", label: "Batteries sold", values: { y: 0, prev: 12, wk: 30, d7: 25, mtd: 40, lm: 35 }, target: 50 }),
            readings,
        };
        const [, cells] = blockATableRows([bat]);
        expect(cells[1]).toBe("—");
        expect(cells[2]).toBe("12+");
        expect(cells[3]).toBe("30");
        expect(cells[4]).toBe("25+");
        expect(cells[5]).toBe("40+");
        expect(cells[8]).toBe("35");
        expect(blockARowNotes([bat])[1]).toBe("Invoices matched to a dealer · At least — 15 of 20 invoices have item lines (month to date)");

        const unknownMtd = { ...bat, readings: { ...readings, mtd: rd("unknown", null, 20, 0) } };
        const [, u] = blockATableRows([unknownMtd]);
        expect(u[5]).toBe("—");
        expect(u[7]).toBe("—"); // no % of target from a false 0
        expect(u[9]).toBe("—"); // nor a Δ
        expect(readingNote(null, unknownMtd.readings)).toBe("No item lines read on the 20 invoices month to date");
        expect(readingNote("x", undefined)).toBe("x");
    });
});
