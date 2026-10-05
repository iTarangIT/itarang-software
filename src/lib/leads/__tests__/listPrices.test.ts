/**
 * E-321 — the never-below-OEM rule and the quote-line list-price snapshot.
 * Pure halves only; the dated register itself needs a database.
 *
 *   npx vitest run src/lib/leads/__tests__/listPrices.test.ts
 */

import { describe, expect, it, vi } from "vitest";

// listPrices.ts imports the db client for its impure half; the pure helpers
// under test never touch it.
vi.mock("@/lib/db", () => ({ db: {} }));

import type { CommercialsProductLine } from "@/lib/inside-sales/types";
import { refKey, type OemPriceRef } from "@/lib/leads/oemPricing";
import {
    listPriceViolations,
    snapshotListPrices,
    windowsOverlap,
    type ListPriceRef,
    type PriceWindow,
} from "@/lib/leads/listPrices";

const d = (s: string) => new Date(`${s}T00:00:00+05:30`);

function w(price: number, from: string, until: string | null): PriceWindow {
    return { price, from: d(from), until: until ? d(until) : null };
}

describe("windowsOverlap (half-open)", () => {
    it("treats adjacent windows as not overlapping", () => {
        expect(windowsOverlap(d("2026-08-01"), d("2026-09-01"), d("2026-09-01"), null)).toBe(false);
    });
    it("treats open-ended windows as running forever", () => {
        expect(windowsOverlap(d("2026-08-01"), null, d("2027-01-01"), null)).toBe(true);
    });
});

describe("listPriceViolations", () => {
    it("allows a list price above or equal to every overlapping OEM price", () => {
        const list = w(50_000, "2026-08-01", null);
        expect(listPriceViolations(list, [w(48_000, "2026-07-01", null)])).toEqual([]);
        expect(listPriceViolations(list, [w(50_000, "2026-07-01", null)])).toEqual([]);
    });

    it("flags an overlapping OEM window priced above the list price", () => {
        const list = w(50_000, "2026-08-01", null);
        const oem = w(52_000, "2026-07-01", null);
        expect(listPriceViolations(list, [oem])).toEqual([oem]);
    });

    it("flags a SCHEDULED OEM rise inside the list window", () => {
        const list = w(50_000, "2026-08-01", null);
        const now = w(48_000, "2026-07-01", "2026-10-01");
        const later = w(51_000, "2026-10-01", null);
        expect(listPriceViolations(list, [now, later])).toEqual([later]);
    });

    it("ignores a higher OEM window that does not overlap", () => {
        const list = w(50_000, "2026-08-01", "2026-10-01");
        const later = w(51_000, "2026-10-01", null);
        const earlier = w(60_000, "2026-01-01", "2026-08-01");
        expect(listPriceViolations(list, [earlier, later])).toEqual([]);
    });

    it("is not violated where there is no OEM price at all", () => {
        expect(listPriceViolations(w(1, "2026-08-01", null), [])).toEqual([]);
    });

    it("answers the OEM side too: one OEM line against a list window", () => {
        const list = w(50_000, "2026-08-01", null);
        expect(listPriceViolations(list, [w(55_000, "2026-09-01", null)])).toHaveLength(1);
        expect(listPriceViolations(list, [w(45_000, "2026-09-01", null)])).toHaveLength(0);
    });
});

describe("snapshotListPrices", () => {
    const line = (product_id: string): CommercialsProductLine => ({
        asset_type: "battery",
        product_id,
        product_name: "51.2V 105AH LFP",
        model_id: "BAT",
        unit_price: 40_000,
        quantity: 2,
    });

    it("prefers the list price, falls back to OEM, else null", () => {
        const listRefs = new Map<string, ListPriceRef>([
            [refKey("battery", "a"), { price_id: "l1", list_price: 45_000 }],
        ]);
        const oemRefs = new Map<string, OemPriceRef>([
            [refKey("battery", "a"), { price_id: "o1", oem_price: 38_000 }],
            [refKey("battery", "b"), { price_id: "o2", oem_price: 39_000 }],
        ]);
        const out = snapshotListPrices([line("a"), line("b"), line("c")], listRefs, oemRefs);
        expect(out.map((l) => l.list_price)).toEqual([45_000, 39_000, null]);
    });

    it("overwrites any list_price the caller sent", () => {
        const out = snapshotListPrices(
            [{ ...line("c"), list_price: 99_999 }],
            new Map(),
            new Map(),
        );
        expect(out[0].list_price).toBeNull();
        expect(out[0].unit_price).toBe(40_000);
    });
});
