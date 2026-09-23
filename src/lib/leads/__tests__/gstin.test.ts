// Tests for the GSTIN rule now required at Mark Converted (review R-11). The
// normalisation must match revenueSource's SQL GSTIN_KEY, or a dealer's
// invoices would silently fail to link.

import { describe, expect, it } from "vitest";
import { isValidGstin, normalizeGstin } from "@/lib/leads/gstin";

describe("normalizeGstin", () => {
    it("upper-cases and strips whitespace, like the SQL join key", () => {
        expect(normalizeGstin(" 07aaacb1234c1z5 ")).toBe("07AAACB1234C1Z5");
        expect(normalizeGstin("07 AAACB 1234 C1Z5")).toBe("07AAACB1234C1Z5");
        expect(normalizeGstin(null)).toBe("");
    });
});

describe("isValidGstin", () => {
    it("accepts a well-formed GSTIN, typed any case", () => {
        expect(isValidGstin("07AAACB1234C1Z5")).toBe(true);
        expect(isValidGstin("06aaacb1234c1z5")).toBe(true);
    });

    it("rejects wrong length, a missing Z, or a PAN typed in its place", () => {
        expect(isValidGstin("07AAACB1234C1Z")).toBe(false);
        expect(isValidGstin("07AAACB1234C1X5")).toBe(false);
        expect(isValidGstin("AAACB1234C")).toBe(false);
        expect(isValidGstin("")).toBe(false);
    });
});
