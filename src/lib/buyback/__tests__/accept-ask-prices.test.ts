/**
 * Review-bar Accept must record the dealer's asking price.
 *
 * The bug: `accept` (SUBMITTED/UNDER_REVIEW → DEALER_ACCEPTED) moved the deal
 * without writing an ACCEPTED final offer, so linesForRequest returned
 * dealer_price = NULL and the Margin & Routing tab showed every line at ₹0
 * (a ₹8,11,931 order quoted to vendors as ₹3,093 of pure margin).
 *
 * buildAskPrices is the pure half of the fix: it turns the dealer's asking
 * prices into the per-line accepted prices, or refuses — it never lets a
 * missing price through as 0.
 */

import { describe, expect, it } from "vitest";

import { buildAskPrices } from "../floor";

const line = (id: string, quantity: number, price: string | number | null, variant = `V-${id}`) => ({
  id,
  variant_type: variant,
  quantity,
  expected_price_per_unit: price,
});

describe("buildAskPrices", () => {
  it("prices every line at the dealer's ask and totals qty × price", () => {
    const r = buildAskPrices([line("a", 2714, "250"), line("b", 235, 300), line("c", 144, "275.5")]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.prices).toEqual([
      { line_id: "a", price_per_unit: 250 },
      { line_id: "b", price_per_unit: 300 },
      { line_id: "c", price_per_unit: 275.5 },
    ]);
    expect(r.total).toBe(2714 * 250 + 235 * 300 + 144 * 275.5);
  });

  it("refuses when a line has no asking price, naming the battery", () => {
    const r = buildAskPrices([line("a", 10, "250"), line("b", 5, null, "25.6V 18Ah")]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("missing");
    expect(r.variant_type).toBe("25.6V 18Ah");
  });

  it("refuses a zero or non-numeric asking price rather than accepting ₹0", () => {
    for (const bad of ["0", 0, "abc", "-5"]) {
      const r = buildAskPrices([line("a", 10, bad as string | number)]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("unusable");
    }
  });

  it("refuses an empty request", () => {
    const r = buildAskPrices([]);
    expect(r.ok).toBe(false);
  });
});
