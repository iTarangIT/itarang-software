import { describe, it, expect } from "vitest";
import {
    BASE_CURRENCY,
    EMERGENCY_FALLBACK_RATES,
    isBaseCurrency,
    normaliseCurrency,
    round2,
} from "./currency";

// E-215. `expense_submissions.amount` is a single column that every dashboard
// SUMs with no notion of currency, so anything mis-classified here is silently
// added to the total at face value — which is how $1,123 of SaaS invoices came
// to be booked as ₹1,123, understating spend by about ₹95,000.
//
// The network/DB half of conversion lives in fx.ts and is exercised by the
// backfill script against real invoices. What is pinned down here is the
// predicate that decides whether conversion happens at all.

describe("isBaseCurrency", () => {
    it("treats the base currency as needing no conversion", () => {
        expect(isBaseCurrency("INR")).toBe(true);
        expect(isBaseCurrency("inr")).toBe(true);
        expect(isBaseCurrency(" INR ")).toBe(true);
    });

    it("treats a missing currency as rupees", () => {
        // The extractor returns null when the document prints no code. On an
        // Indian company's books that is a rupee bill — and NOT a reason to
        // flag or convert, or most of the folder would be flagged.
        expect(isBaseCurrency(null)).toBe(true);
        expect(isBaseCurrency(undefined)).toBe(true);
        expect(isBaseCurrency("")).toBe(true);
    });

    it("flags every foreign currency for conversion", () => {
        // Exactly what turned up in the live accounts folder.
        expect(isBaseCurrency("USD")).toBe(false);
        expect(isBaseCurrency("usd")).toBe(false);
        expect(isBaseCurrency("EUR")).toBe(false);
        expect(isBaseCurrency("GBP")).toBe(false);
    });
});

describe("normaliseCurrency", () => {
    it("upper-cases and trims", () => {
        expect(normaliseCurrency(" usd ")).toBe("USD");
    });
    it("returns null for nothing", () => {
        expect(normaliseCurrency(null)).toBeNull();
        expect(normaliseCurrency("")).toBeNull();
        expect(normaliseCurrency("   ")).toBeNull();
    });
});

describe("round2", () => {
    it("rounds to the 2dp numeric(14,2) stores anyway", () => {
        expect(round2(200 * 94.26)).toBe(18852);
        expect(round2(18.005)).toBe(18.01);
        expect(round2(5 * 95.27)).toBe(476.35);
    });
});

describe("EMERGENCY_FALLBACK_RATES", () => {
    it("is in the right order of magnitude for INR quotes", () => {
        // A units-per-rupee mix-up here would silently divide spend by ~9000.
        expect(EMERGENCY_FALLBACK_RATES.USD).toBeGreaterThan(50);
        expect(EMERGENCY_FALLBACK_RATES.USD).toBeLessThan(200);
        expect(EMERGENCY_FALLBACK_RATES.EUR).toBeGreaterThan(EMERGENCY_FALLBACK_RATES.USD);
    });

    it("quotes JPY per single yen", () => {
        // Not a typo: 1 JPY is well under 1 INR.
        expect(EMERGENCY_FALLBACK_RATES.JPY).toBeLessThan(2);
    });

    it("does not claim a rate for the base currency", () => {
        expect(EMERGENCY_FALLBACK_RATES[BASE_CURRENCY]).toBeUndefined();
    });
});
