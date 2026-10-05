// E-323 (IDs 4, 47) — the pure list price rules: list is never below OEM in
// any window it covers, and what one quotation line prints.

import { describe, expect, it } from "vitest";
import { firstListBelowOem, firstOemAboveList, printedListPrice, windowsOverlap } from "@/lib/leads/listPricing";

const d = (s: string) => new Date(`${s}T00:00:00+05:30`);

describe("windowsOverlap", () => {
    it("treats windows as half-open, so adjacent ones do not overlap", () => {
        expect(windowsOverlap({ from: d("2026-08-01"), until: d("2026-09-01") }, { from: d("2026-09-01"), until: null })).toBe(false);
        expect(windowsOverlap({ from: d("2026-08-01"), until: null }, { from: d("2026-09-01"), until: null })).toBe(true);
    });
});

describe("list price is never below the OEM price", () => {
    const oem = [
        { from: d("2026-08-01"), until: d("2026-10-01"), price: 40_000 },
        // A scheduled OEM rise.
        { from: d("2026-10-01"), until: null, price: 45_000 },
    ];

    it("refuses a list price below a scheduled OEM price it overlaps", () => {
        const hit = firstOemAboveList({ from: d("2026-09-01"), until: null, price: 42_000 }, oem);
        expect(hit?.price).toBe(45_000);
    });

    it("accepts it when the window ends before the rise, or the price clears every window", () => {
        expect(firstOemAboveList({ from: d("2026-09-01"), until: d("2026-10-01"), price: 42_000 }, oem)).toBeNull();
        expect(firstOemAboveList({ from: d("2026-09-01"), until: null, price: 45_000 }, oem)).toBeNull();
    });

    it("refuses an OEM rise above a list price in force", () => {
        const list = [{ from: d("2026-08-01"), until: null, price: 44_000 }];
        expect(firstListBelowOem({ from: d("2026-10-01"), until: null, price: 45_000 }, list)?.price).toBe(44_000);
        expect(firstListBelowOem({ from: d("2026-10-01"), until: null, price: 44_000 }, list)).toBeNull();
    });
});

describe("printedListPrice", () => {
    it("prints the admin list price and the discount against the net price", () => {
        expect(printedListPrice({ listPrice: 50_000, oemPrice: 40_000, netPrice: 44_000 })).toEqual({ listPrice: 50_000, discount: 6_000 });
    });

    it("falls back to the OEM price when no list price is set", () => {
        expect(printedListPrice({ listPrice: null, oemPrice: 46_000, netPrice: 44_000 })).toEqual({ listPrice: 46_000, discount: 2_000 });
    });

    it("never prints a list price below the net price, so there is no negative discount", () => {
        expect(printedListPrice({ listPrice: 42_000, oemPrice: 40_000, netPrice: 44_000 })).toEqual({ listPrice: 44_000, discount: 0 });
    });

    it("prints nothing when the product has neither price", () => {
        expect(printedListPrice({ listPrice: null, oemPrice: null, netPrice: 44_000 })).toBeNull();
    });
});
