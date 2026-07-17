/**
 * M08 — the guard on the number the floor is built on.
 *
 * This exists because of a bug that was invisible for the life of the module and
 * would have been permanent the first time it fired.
 *
 * margin/route.ts validated the dealer's accepted price with:
 *
 *     const dealerPrice = Number(line.dealer_price);
 *     if (!Number.isFinite(dealerPrice)) throw new ValidationError("No accepted price...")
 *
 * which every reader — including several who touched the file — reads as "reject
 * a missing price". It does not. `Number(null)` is `0`, and `Number.isFinite(0)`
 * is `true`, so an UNPRICED line passed the guard and was written into
 * deal_line_locks at ₹0. That table is INSERT-only and fill-once: the dealer's
 * price for the deal would have been permanently zero, floor_total would have
 * been Σ qty × margin with no cost in it, and every document and report reads
 * from those locks. Nothing would have complained.
 *
 * It never fired only because every acceptance on db-1 so far went through
 * `dealer_accept`, whose final-offer route refuses to send unless every line is
 * priced. The review-bar `accept` — legal, wired, and used zero times — prices
 * nothing at all. Luck, not design.
 *
 * The lesson worth keeping: `Number(x)` silently maps null, "", false and [] all
 * to 0. A guard built on it is not a null check. Test the coercion, not the
 * intent.
 */

import { describe, expect, it } from "vitest";

import { resolveDealerPrice } from "../floor";

describe("a missing price is refused as MISSING", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["empty string", ""],
  ])("%s", (_label, value) => {
    const r = resolveDealerPrice(value as null | undefined | string);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("missing");
  });

  it("does NOT coerce null to zero and accept it — the actual bug", () => {
    // The regression, stated as plainly as it can be. If this ever passes with
    // ok:true, an unpriced line can be locked at ₹0 again.
    expect(Number(null)).toBe(0);
    expect(Number.isFinite(Number(null))).toBe(true);
    expect(resolveDealerPrice(null).ok).toBe(false);
  });
});

describe("a nonsensical price is refused as UNUSABLE", () => {
  // Distinct from "missing" on purpose: null means nobody agreed a price; zero
  // means something wrote one that cannot be true. Conflating them is what hid
  // the bug for so long.
  it.each([
    ["zero", 0],
    ["string zero", "0"],
    ["numeric-string zero", "0.00"],
    ["negative", -100],
    ["not a number", "abc"],
    ["NaN", NaN],
    ["Infinity", Infinity],
  ])("%s", (_label, value) => {
    const r = resolveDealerPrice(value as number | string);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unusable");
  });
});

describe("a real price is accepted, as a number", () => {
  it("takes a numeric string — postgres NUMERIC arrives as one", () => {
    const r = resolveDealerPrice("4100.00");
    expect(r).toEqual({ ok: true, price: 4100 });
  });

  it("takes a number", () => {
    expect(resolveDealerPrice(4100)).toEqual({ ok: true, price: 4100 });
  });

  it("takes the reported real deal — BB-1052's ₹4,100", () => {
    const r = resolveDealerPrice("4100.00");
    expect(r.ok && r.price).toBe(4100);
  });

  it("accepts a small but real price", () => {
    // 1 is not 0. The floor only refuses non-positive.
    expect(resolveDealerPrice(1)).toEqual({ ok: true, price: 1 });
  });
});
