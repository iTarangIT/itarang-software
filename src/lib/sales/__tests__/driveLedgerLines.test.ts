import { describe, expect, it } from "vitest";
import { checkDriveLines, reconcileDriveLines, toLedgerRows } from "@/lib/sales/driveLedgerLinesRules";
import type { InvoiceLine } from "@/lib/sales/salesInvoiceLines";

const line = (p: Partial<InvoiceLine>): InvoiceLine => ({
    line_no: 1,
    description: "Trontek Li Battery 51V 105Ah",
    item_key: "trontek li battery 51v 105ah",
    hsn_code: "85076000",
    quantity: 75,
    rate: 47500,
    amount: 3562500,
    ...p,
});

describe("checkDriveLines", () => {
    // ITG/202627/067, read by eye 6 Oct 2026: 75 × ₹47,500 = ₹35,62,500 taxable.
    it("trusts lines that add up and whose qty × rate = amount", () => {
        expect(checkDriveLines([line({})], 3562500)).toEqual({ ok: true });
    });

    it("rejects lines that do not add up to the taxable value", () => {
        const r = checkDriveLines([line({ amount: 3000000, quantity: 75, rate: 40000 })], 3562500);
        expect(r.ok).toBe(false);
        expect(r.ok === false && r.reason).toMatch(/add up/);
    });

    it("rejects a misread quantity even when the amounts add up", () => {
        // 57 instead of 75: amount still matches the sub-total, qty × rate does not.
        const r = checkDriveLines([line({ quantity: 57 })], 3562500);
        expect(r.ok).toBe(false);
        expect(r.ok === false && r.reason).toMatch(/quantity/);
    });

    it("accepts a line with no printed rate when the total adds up", () => {
        expect(checkDriveLines([line({ rate: null })], 3562500)).toEqual({ ok: true });
    });

    it("tolerates rounding on qty × rate", () => {
        // 3 × 846.61 = 2539.83 printed as 2539.85
        expect(checkDriveLines([line({ quantity: 3, rate: 846.61, amount: 2539.85 })], 2539.85).ok).toBe(true);
    });

    it("rejects an empty read", () => {
        expect(checkDriveLines([], 3562500).ok).toBe(false);
    });
});

describe("toLedgerRows", () => {
    it("classifies by HSN and keeps quantity / taxable amount", () => {
        const rows = toLedgerRows([
            line({}),
            line({ line_no: 2, description: "Charger 58.4V 20A", hsn_code: "85044090", quantity: 2, rate: 3000, amount: 6000 }),
            line({ line_no: 3, description: "Freight", hsn_code: "996511", quantity: 1, rate: 500, amount: 500 }),
        ]);
        expect(rows.map((r) => [r.line_no, r.product_class, r.quantity, r.amount_excl_gst])).toEqual([
            [1, "battery", 75, 3562500],
            [2, "charger", 2, 6000],
            [3, "other", 1, 500],
        ]);
        expect(rows[0].hsn).toBe("85076000");
        expect(rows[0].item_name).toBe("Trontek Li Battery 51V 105Ah");
    });
});

describe("reconcileDriveLines", () => {
    // ITG/202627/059, read by eye 6 Oct 2026: the Vyapar "Amount" column is
    // GST-INCLUSIVE (₹2,89,100 for 5 batteries) while Price/Unit is pre-tax
    // (₹49,000). The model copies the printed Amount, so the lines sum to the
    // grand total ₹3,25,610, not the taxable ₹2,78,750 — yet qty × price does.
    const inv059 = [
        line({ line_no: 1, quantity: 5, rate: 49000, amount: 289100 }),
        line({ line_no: 2, description: "EV Battery Charger 1200W", hsn_code: "85044030", quantity: 5, rate: 5100, amount: 26775 }),
        line({ line_no: 3, description: "LCD Display with Box", hsn_code: "85079090", quantity: 5, rate: 600, amount: 3540 }),
        line({ line_no: 4, description: "Wiring Harness SB-75", hsn_code: "85366990", quantity: 5, rate: 1050, amount: 6195 }),
    ];

    it("accepts GST-inclusive amounts when qty × price adds up to the taxable value", () => {
        const r = reconcileDriveLines(inv059, 278750);
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.basis).toBe("qty_x_rate");
            expect(r.lines.map((l) => l.amount)).toEqual([245000, 25500, 3000, 5250]);
            expect(r.lines.map((l) => l.quantity)).toEqual([5, 5, 5, 5]);
        }
    });

    it("keeps read amounts when they already check out", () => {
        const r = reconcileDriveLines([line({})], 3562500);
        expect(r.ok && r.basis).toBe("amounts");
    });

    it("refuses when neither amounts nor qty × price add up", () => {
        const r = reconcileDriveLines([line({ quantity: 57, rate: 47500, amount: 4203750 })], 3562500);
        expect(r.ok).toBe(false);
    });

    it("refuses the qty × price route when any line has no price", () => {
        const lines = inv059.map((l, i) => (i === 3 ? { ...l, rate: null } : l));
        expect(reconcileDriveLines(lines, 278750).ok).toBe(false);
    });
});
