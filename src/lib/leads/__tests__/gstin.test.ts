// Tests for the GSTIN rule required at Mark Won and everywhere a GSTIN enters
// the CRM (review R-11, tracker ID 62). The normalisation must match
// revenueSource's SQL GSTIN_KEY, or a dealer's invoices would silently fail to
// link.

import { describe, expect, it } from "vitest";
import {
    checkCustomerGstin,
    checkGstin,
    gstinCheckDigit,
    isOwnGstin,
    isValidGstin,
    normalizeGstin,
} from "@/lib/leads/gstin";

describe("normalizeGstin", () => {
    it("upper-cases and strips whitespace, like the SQL join key", () => {
        expect(normalizeGstin(" 07aaacb1234c1zh ")).toBe("07AAACB1234C1ZH");
        expect(normalizeGstin("07 AAACB 1234 C1ZH")).toBe("07AAACB1234C1ZH");
        expect(normalizeGstin(null)).toBe("");
    });
});

describe("isValidGstin", () => {
    it("accepts a well-formed GSTIN, typed any case", () => {
        expect(isValidGstin("07AAACB1234C1ZH")).toBe(true);
        expect(isValidGstin("06aaacb1234c1zj")).toBe(true);
    });

    it("rejects wrong length, a missing Z, or a PAN typed in its place", () => {
        expect(isValidGstin("07AAACB1234C1Z")).toBe(false);
        expect(isValidGstin("07AAACB1234C1XH")).toBe(false);
        expect(isValidGstin("AAACB1234C")).toBe(false);
        expect(isValidGstin("")).toBe(false);
    });
});

describe("check digit (ID 62)", () => {
    it("computes the 15th character of real registrations", () => {
        expect(gstinCheckDigit("06AALFI7813E1Z")).toBe("E");
        expect(gstinCheckDigit("07AALFI7813E1Z")).toBe("C");
        expect(gstinCheckDigit("09GVUPP6577G1Z")).toBe("F");
        expect(gstinCheckDigit("27AABCB1518L1Z")).toBe("S");
        expect(gstinCheckDigit("27AABCB1518L1")).toBeNull();
    });

    it("refuses the right shape with the wrong last character, or one mistyped character", () => {
        expect(checkGstin("07AAACB1234C1Z5")).toBe("bad_check_digit");
        expect(checkGstin("09GVUPP6577G1ZE")).toBe("bad_check_digit");
        expect(checkGstin("09GVUPP6578G1ZF")).toBe("bad_check_digit");
        expect(checkGstin("09GVUPP6577G1ZF")).toBe("ok");
        expect(checkGstin("09GVUPP")).toBe("bad_shape");
    });

    it("never takes iTarang's own GSTIN as a customer's", () => {
        expect(isOwnGstin("06aalfi7813e1ze")).toBe(true);
        expect(checkCustomerGstin("06AALFI7813E1ZE")).toBe("own_gstin");
        expect(checkCustomerGstin("07AALFI7813E1ZC")).toBe("own_gstin");
        expect(checkCustomerGstin("09GVUPP6577G1ZF")).toBe("ok");
        expect(checkCustomerGstin("09GVUPP6577G1ZE")).toBe("bad_check_digit");
    });
});
