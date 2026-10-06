import { describe, expect, it } from "vitest";
import { checkDriveLines, toLedgerRows } from "@/lib/sales/driveLedgerLinesRules";
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
