import { describe, expect, it } from "vitest";
import {
    evaluateAgainstOemPrices,
    linesNeedingAttention,
    OEM_RULE_VERSION,
    refKey,
    referenceKeysFor,
    resolveQuoteApproval,
    type OemPriceRef,
} from "./oemPricing";
import type { AssetType, CommercialsProductLine } from "@/lib/inside-sales/types";

// E-226 auto-approves a quote whose every line is at or above the OEM reference
// price. What is worth pinning is the fail-closed edges — the ways a quote can
// have no number to compare — because each of them, read the other way, would
// release an unexamined price to a dealer.

const AT = new Date("2026-08-03T10:00:00.000Z");

function line(
    over: Partial<CommercialsProductLine> & { product_id: string },
): CommercialsProductLine {
    return {
        asset_type: "battery" as AssetType,
        product_name: `Product ${over.product_id}`,
        model_id: `M-${over.product_id}`,
        unit_price: 1000,
        quantity: 1,
        ...over,
    };
}

function refs(
    entries: Array<[string, number, string?]>,
    assetType: AssetType = "battery",
): Map<string, OemPriceRef> {
    return new Map(
        entries.map(([productId, price, priceId]) => [
            refKey(assetType, productId),
            { price_id: priceId ?? `price-${productId}`, oem_price: price },
        ]),
    );
}

describe("evaluateAgainstOemPrices — the auto-approve path", () => {
    it("auto-approves when every line is above reference", () => {
        const e = evaluateAgainstOemPrices(
            [line({ product_id: "a", unit_price: 1200 }), line({ product_id: "b", unit_price: 900 })],
            refs([
                ["a", 1000],
                ["b", 800],
            ]),
            AT,
        );
        expect(e.outcome).toBe("auto_approved");
        expect(e.reason).toBe("at_or_above_reference");
        expect(e.shortfall_total).toBe(0);
        expect(resolveQuoteApproval(e)).toEqual({ status: "approved", mode: "auto" });
    });

    // The spec is ">=", so the boundary belongs on the auto side. Off by one
    // here would send every exactly-at-list quote to the CEO.
    it("auto-approves a line priced exactly at reference", () => {
        const e = evaluateAgainstOemPrices(
            [line({ product_id: "a", unit_price: 1000 })],
            refs([["a", 1000]]),
            AT,
        );
        expect(e.outcome).toBe("auto_approved");
        expect(e.lines[0].status).toBe("at_or_above");
        expect(e.lines[0].delta).toBe(0);
    });

    it("stamps the rule version and the evaluation time", () => {
        const e = evaluateAgainstOemPrices(
            [line({ product_id: "a", unit_price: 1000 })],
            refs([["a", 1000]]),
            AT,
        );
        expect(e.rule).toBe(OEM_RULE_VERSION);
        expect(e.evaluated_at).toBe("2026-08-03T10:00:00.000Z");
    });

    // The price_id is what keeps an approved quote auditable after the price
    // book moves on — without it the snapshot is just a number with no source.
    it("records which reference row was used", () => {
        const e = evaluateAgainstOemPrices(
            [line({ product_id: "a", unit_price: 1000 })],
            refs([["a", 1000, "price-row-42"]]),
            AT,
        );
        expect(e.lines[0].price_id).toBe("price-row-42");
        expect(e.lines[0].oem_price).toBe(1000);
    });
});

describe("evaluateAgainstOemPrices — everything that must NOT auto-approve", () => {
    // The headline rule: one discounted line holds the whole quote, because a
    // quote is approved as a single document.
    it("sends the whole quote to the CEO when one line is below reference", () => {
        const e = evaluateAgainstOemPrices(
            [
                line({ product_id: "a", unit_price: 42000 }),
                line({ product_id: "b", asset_type: "charger", unit_price: 3200 }),
                line({ product_id: "c", asset_type: "paraphernalia", unit_price: 800 }),
            ],
            new Map([
                [refKey("battery", "a"), { price_id: "p1", oem_price: 40000 }],
                [refKey("charger", "b"), { price_id: "p2", oem_price: 3500 }],
                [refKey("paraphernalia", "c"), { price_id: "p3", oem_price: 800 }],
            ]),
            AT,
        );
        expect(e.outcome).toBe("manual_required");
        expect(e.reason).toBe("below_reference");
        expect(e.lines.map((l) => l.status)).toEqual([
            "at_or_above",
            "below",
            "at_or_above",
        ]);
        expect(resolveQuoteApproval(e)).toEqual({ status: "pending", mode: "manual" });
    });

    // Fail-closed on an unknown product. Read the other way, a brand-new SKU
    // could be quoted at any number with no review at all.
    it("holds a quote for a product with no reference price", () => {
        const e = evaluateAgainstOemPrices(
            [line({ product_id: "a", unit_price: 5000 }), line({ product_id: "unknown" })],
            refs([["a", 1000]]),
            AT,
        );
        expect(e.outcome).toBe("manual_required");
        expect(e.reason).toBe("missing_reference");
        expect(e.lines[1]).toMatchObject({
            status: "no_reference",
            oem_price: null,
            price_id: null,
            delta: null,
        });
    });

    it("holds a quote when the rep left a line unpriced", () => {
        const e = evaluateAgainstOemPrices(
            [line({ product_id: "a", unit_price: null })],
            refs([["a", 1000]]),
            AT,
        );
        expect(e.outcome).toBe("manual_required");
        expect(e.reason).toBe("unpriced_line");
        expect(e.lines[0]).toMatchObject({ status: "unpriced", delta: null });
        // The reference is still reported, so the CEO sees what it should be.
        expect(e.lines[0].oem_price).toBe(1000);
    });

    // A lump-sum quote carrying only final_price has nothing to check.
    it("holds a quote with no product lines at all", () => {
        const e = evaluateAgainstOemPrices([], new Map(), AT);
        expect(e.outcome).toBe("manual_required");
        expect(e.reason).toBe("no_product_lines");
        expect(e.lines).toEqual([]);
        expect(e.shortfall_total).toBe(0);
    });

    it("holds a quote when nothing has been priced yet — the day-one state", () => {
        const e = evaluateAgainstOemPrices(
            [line({ product_id: "a" }), line({ product_id: "b" })],
            new Map(),
            AT,
        );
        expect(e.outcome).toBe("manual_required");
        expect(e.reason).toBe("missing_reference");
    });
});

describe("reason precedence", () => {
    // below_reference is the one that needs a commercial decision; the others
    // are data gaps. The panel leads with whichever this returns, so a quote
    // that is both short AND missing a reference must say it is short.
    it("reports below_reference ahead of a missing reference", () => {
        const e = evaluateAgainstOemPrices(
            [line({ product_id: "a", unit_price: 900 }), line({ product_id: "gap" })],
            refs([["a", 1000]]),
            AT,
        );
        expect(e.reason).toBe("below_reference");
    });

    it("reports a missing reference ahead of an unpriced line", () => {
        const e = evaluateAgainstOemPrices(
            [line({ product_id: "gap" }), line({ product_id: "b", unit_price: null })],
            refs([["b", 1000]]),
            AT,
        );
        expect(e.reason).toBe("missing_reference");
    });
});

describe("shortfall_total", () => {
    it("multiplies the per-unit gap by quantity", () => {
        const e = evaluateAgainstOemPrices(
            [line({ product_id: "a", unit_price: 900, quantity: 5 })],
            refs([["a", 1000]]),
            AT,
        );
        expect(e.shortfall_total).toBe(500);
    });

    it("sums across every short line and ignores the healthy ones", () => {
        const e = evaluateAgainstOemPrices(
            [
                line({ product_id: "a", unit_price: 900, quantity: 2 }), // 200 short
                line({ product_id: "b", unit_price: 700, quantity: 3 }), // 900 short
                line({ product_id: "c", unit_price: 5000, quantity: 4 }), // over — ignored
            ],
            refs([
                ["a", 1000],
                ["b", 1000],
                ["c", 1000],
            ]),
            AT,
        );
        // Not netted against the +16,000 surplus on line c: the concession is
        // what it is, whatever else the deal earns.
        expect(e.shortfall_total).toBe(1100);
    });

    it("is zero when a line has no number to be short by", () => {
        const e = evaluateAgainstOemPrices(
            [line({ product_id: "a", unit_price: null, quantity: 9 }), line({ product_id: "gap" })],
            refs([["a", 1000]]),
            AT,
        );
        expect(e.shortfall_total).toBe(0);
    });
});

describe("linesNeedingAttention", () => {
    it("counts every line that is not clearly at or above reference", () => {
        const e = evaluateAgainstOemPrices(
            [
                line({ product_id: "a", unit_price: 1200 }),
                line({ product_id: "b", unit_price: 900 }),
                line({ product_id: "gap" }),
            ],
            refs([
                ["a", 1000],
                ["b", 1000],
            ]),
            AT,
        );
        expect(linesNeedingAttention(e)).toBe(2);
    });
});

describe("referenceKeysFor", () => {
    it("scopes the key by asset type — ids collide across the three masters", () => {
        expect(refKey("battery", "x")).not.toBe(refKey("charger", "x"));
        expect(
            referenceKeysFor([
                line({ product_id: "x" }),
                line({ product_id: "x", asset_type: "charger" }),
            ]),
        ).toEqual(["battery:x", "charger:x"]);
    });

    it("deduplicates a product quoted on two lines", () => {
        expect(
            referenceKeysFor([line({ product_id: "x" }), line({ product_id: "x" })]),
        ).toEqual(["battery:x"]);
    });
});
