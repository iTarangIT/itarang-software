import { describe, expect, it } from "vitest";
import { buildQuotePreview } from "../quotePreview";
import type { CommercialsProductLine } from "../types";

const line = (p: Partial<CommercialsProductLine>): CommercialsProductLine => ({
    asset_type: "battery",
    product_id: "p1",
    product_name: "Battery",
    model_id: "M1",
    unit_price: 100,
    quantity: 1,
    ...p,
});

describe("buildQuotePreview", () => {
    it("adds GST per line at each line's rate", () => {
        const p = buildQuotePreview(
            [line({ unit_price: 50000, quantity: 2 }), line({ asset_type: "charger", product_id: "c1", unit_price: 4000, quantity: 3 })],
            (l) => (l.asset_type === "charger" ? 5 : 18),
        );
        expect(p.subTotal).toBe(112000);
        expect(p.gstTotal).toBe(18000 + 600);
        expect(p.total).toBe(130600);
        expect(p.lines.map((l) => l.gst)).toEqual([18000, 600]);
        expect(p.hasUnsetGst).toBe(false);
    });

    it("rounds each line's GST to paise like the PDF", () => {
        const p = buildQuotePreview([line({ unit_price: 333.33, quantity: 1 })], () => 18);
        expect(p.gstTotal).toBe(60);
        expect(p.total).toBe(393.33);
    });

    it("flags an unpriced line and leaves it out of the totals", () => {
        const p = buildQuotePreview([line({ unit_price: null }), line({ product_id: "p2", unit_price: 100 })], () => 18);
        expect(p.hasUnpriced).toBe(true);
        expect(p.subTotal).toBe(100);
        expect(p.total).toBe(118);
    });

    it("flags a line with no GST rate instead of treating it as zero-rated", () => {
        const p = buildQuotePreview([line({ unit_price: 100 })], () => null);
        expect(p.hasUnsetGst).toBe(true);
        expect(p.lines[0].gst).toBeNull();
        expect(p.total).toBe(100);
    });
});
