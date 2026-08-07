/**
 * E-226/E-230 — the quotation auto-approval rule.
 *
 * This is the half of the flow that decides whether a dealer sees a price
 * immediately or waits for the CEO, and it is pure: lines in, verdict out, no
 * connection. So it is the half that can be tested exhaustively, and the half
 * worth pinning — every one of these cases is a way the rule could quietly
 * start releasing quotes it should have escalated.
 *
 *   npx vitest run src/lib/leads/__tests__/oemPricing.test.ts
 *
 * The dated register that FEEDS `refs` is stateful and lives in
 * scripts/test-oem-pricing-flow.ts, which needs a database.
 */

import { describe, expect, it } from "vitest";
import type { CommercialsProductLine } from "@/lib/inside-sales/types";
import {
    evaluateAgainstOemPrices,
    linesNeedingAttention,
    referenceKeysFor,
    refKey,
    resolveQuoteApproval,
    type OemPriceRef,
} from "@/lib/leads/oemPricing";

const AT = new Date("2026-08-07T10:00:00+05:30");

function line(
    over: Partial<CommercialsProductLine> & { product_id: string },
): CommercialsProductLine {
    return {
        asset_type: "battery",
        product_name: "51.2V 105AH LFP",
        model_id: "BAT-51V-105AH-3W",
        unit_price: 60_000,
        quantity: 1,
        ...over,
    } as CommercialsProductLine;
}

function refs(
    entries: Array<[string, string, number]>,
): Map<string, OemPriceRef> {
    return new Map(
        entries.map(([asset, id, price], i) => [
            refKey(asset, id),
            { price_id: `price-${i}`, oem_price: price },
        ]),
    );
}

describe("evaluateAgainstOemPrices — the release decision", () => {
    it("auto-approves when every line clears its reference price", () => {
        const e = evaluateAgainstOemPrices(
            [line({ product_id: "p1", unit_price: 60_000 })],
            refs([["battery", "p1", 50_000]]),
            AT,
        );

        expect(e.outcome).toBe("auto_approved");
        expect(e.reason).toBe("at_or_above_reference");
        expect(e.shortfall_total).toBe(0);
        expect(e.lines[0].status).toBe("at_or_above");
        expect(e.lines[0].delta).toBe(10_000);
    });

    it("auto-approves at EXACTLY the reference price — the spec is 'at or above'", () => {
        const e = evaluateAgainstOemPrices(
            [line({ product_id: "p1", unit_price: 50_000 })],
            refs([["battery", "p1", 50_000]]),
            AT,
        );

        expect(e.outcome).toBe("auto_approved");
        expect(e.lines[0].delta).toBe(0);
    });

    it("escalates a line one rupee below reference", () => {
        const e = evaluateAgainstOemPrices(
            [line({ product_id: "p1", unit_price: 49_999 })],
            refs([["battery", "p1", 50_000]]),
            AT,
        );

        expect(e.outcome).toBe("manual_required");
        expect(e.reason).toBe("below_reference");
        expect(e.lines[0].status).toBe("below");
    });

    it("escalates the WHOLE quote when one line of several is below", () => {
        // The point of the rule: a healthy line must not subsidise a
        // loss-making one silently. That netting-out is the judgement being
        // escalated, not a detail to average away.
        const e = evaluateAgainstOemPrices(
            [
                line({ product_id: "p1", unit_price: 90_000 }),
                line({ product_id: "p2", unit_price: 10_000, asset_type: "charger" }),
            ],
            refs([
                ["battery", "p1", 50_000],
                ["charger", "p2", 12_000],
            ]),
            AT,
        );

        expect(e.outcome).toBe("manual_required");
        expect(e.reason).toBe("below_reference");
        expect(linesNeedingAttention(e)).toBe(1);
    });

    it("escalates a product with no price on file, rather than passing it", () => {
        // Fail closed. An unpriced product is precisely the one nobody has
        // margin-checked, so 'no reference' must never read as 'fine'.
        const e = evaluateAgainstOemPrices(
            [line({ product_id: "p1", unit_price: 999_999 })],
            new Map(),
            AT,
        );

        expect(e.outcome).toBe("manual_required");
        expect(e.reason).toBe("missing_reference");
        expect(e.lines[0].status).toBe("no_reference");
        expect(e.lines[0].oem_price).toBeNull();
    });

    it("escalates a line the rep left blank, even with a reference on file", () => {
        const e = evaluateAgainstOemPrices(
            [line({ product_id: "p1", unit_price: null })],
            refs([["battery", "p1", 50_000]]),
            AT,
        );

        expect(e.outcome).toBe("manual_required");
        expect(e.reason).toBe("unpriced_line");
        expect(e.lines[0].status).toBe("unpriced");
        expect(e.lines[0].delta).toBeNull();
    });

    it("escalates a quote with no product lines at all", () => {
        // A lump-sum final_price has nothing to check against.
        const e = evaluateAgainstOemPrices([], new Map(), AT);

        expect(e.outcome).toBe("manual_required");
        expect(e.reason).toBe("no_product_lines");
    });

    it("reports the most serious problem first: below beats missing beats blank", () => {
        const e = evaluateAgainstOemPrices(
            [
                line({ product_id: "below", unit_price: 40_000 }),
                line({ product_id: "noref", unit_price: 40_000 }),
                line({ product_id: "blank", unit_price: null }),
            ],
            refs([
                ["battery", "below", 50_000],
                ["battery", "blank", 50_000],
            ]),
            AT,
        );

        expect(e.reason).toBe("below_reference");
        expect(linesNeedingAttention(e)).toBe(3);
    });

    it("sums the shortfall in rupees on the deal, not per unit", () => {
        // The CEO is deciding about the money on this order, so the gap is
        // multiplied by quantity even though the comparison is per unit.
        const e = evaluateAgainstOemPrices(
            [
                line({ product_id: "p1", unit_price: 45_000, quantity: 10 }),
                line({ product_id: "p2", unit_price: 80_000, quantity: 3 }),
            ],
            refs([
                ["battery", "p1", 50_000],
                ["battery", "p2", 70_000],
            ]),
            AT,
        );

        // 5,000 short × 10 = 50,000. The second line is ABOVE and must not
        // reduce the number.
        expect(e.shortfall_total).toBe(50_000);
    });

    it("keys references per asset_type — ids are only unique within a master", () => {
        // A battery and a paraphernalia row can legitimately share a product_id
        // string. Matching on id alone would price one against the other.
        const e = evaluateAgainstOemPrices(
            [line({ product_id: "same", asset_type: "charger", unit_price: 9_000 })],
            refs([["battery", "same", 1_000]]),
            AT,
        );

        expect(e.reason).toBe("missing_reference");
    });

    it("stamps the rule version and the instant it was judged", () => {
        // An old quote must still say which rule judged it — a snapshot that
        // silently means something new is worse than no snapshot.
        const e = evaluateAgainstOemPrices(
            [line({ product_id: "p1" })],
            refs([["battery", "p1", 50_000]]),
            AT,
        );

        expect(e.rule).toBe("per_line_v1");
        expect(e.evaluated_at).toBe(AT.toISOString());
    });
});

describe("resolveQuoteApproval — how the verdict lands on the quote", () => {
    it("auto-approved becomes approved/auto", () => {
        const e = evaluateAgainstOemPrices(
            [line({ product_id: "p1", unit_price: 60_000 })],
            refs([["battery", "p1", 50_000]]),
            AT,
        );
        expect(resolveQuoteApproval(e)).toEqual({ status: "approved", mode: "auto" });
    });

    it("anything else becomes pending/manual — the CEO queue", () => {
        const e = evaluateAgainstOemPrices([], new Map(), AT);
        expect(resolveQuoteApproval(e)).toEqual({ status: "pending", mode: "manual" });
    });
});

describe("referenceKeysFor", () => {
    it("deduplicates a product that appears on two lines", () => {
        const keys = referenceKeysFor([
            line({ product_id: "p1" }),
            line({ product_id: "p1", quantity: 4 }),
            line({ product_id: "p2" }),
        ]);
        expect(keys).toEqual(["battery:p1", "battery:p2"]);
    });
});
