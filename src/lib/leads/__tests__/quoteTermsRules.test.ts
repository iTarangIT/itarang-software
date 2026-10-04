import { describe, expect, it } from "vitest";
import {
    DEFAULT_STANDARD_TERMS,
    QuoteTermsSchema,
    applyTermsHold,
    formatCreditTerms,
    mergeStandardTerms,
    resolveQuoteTerms,
    termsHold,
} from "@/lib/leads/quoteTermsRules";

const STD = { warranty: "36 months", delivery: "Ex-works Gurugram" };

describe("quote terms (ID 73)", () => {
    it("any credit term holds the quote for approval, even when the price cleared", () => {
        const t = resolveQuoteTerms({ dealer_payment_terms: "credit", credit_days: 30 }, STD);
        const hold = termsHold(t);
        expect(hold).toEqual({ reason: "credit_terms", credit_days: 30 });
        expect(applyTermsHold({ status: "approved", mode: "auto" }, hold)).toEqual({ status: "pending", mode: "manual" });
    });

    it("cash adds no hold — the price verdict stands", () => {
        const t = resolveQuoteTerms({ dealer_payment_terms: "cash", credit_days: 45 }, STD);
        expect(t.credit_days).toBeNull();
        expect(termsHold(t)).toBeNull();
        expect(applyTermsHold({ status: "approved", mode: "auto" }, null)).toEqual({ status: "approved", mode: "auto" });
        expect(applyTermsHold({ status: "pending", mode: "manual" }, null)).toEqual({ status: "pending", mode: "manual" });
    });

    it("warranty and delivery always come from the standard terms", () => {
        const t = resolveQuoteTerms({ dealer_payment_terms: "cash" }, STD);
        expect(t.warranty_terms).toBe("36 months");
        expect(t.delivery_terms).toBe("Ex-works Gurugram");
        expect(t.credit_terms).toBe("Cash");
    });

    it("customer finance is separate from payment terms and mirrors payment_method for onboarding", () => {
        expect(resolveQuoteTerms({ dealer_payment_terms: "cash", customer_finance: true }, STD).payment_method).toBe("finance");
        expect(resolveQuoteTerms({ dealer_payment_terms: "credit", credit_days: 15, customer_finance: false }, STD).payment_method).toBe("cash");
        expect(resolveQuoteTerms({ dealer_payment_terms: "cash" }, STD).payment_method).toBeNull();
    });

    it("credit needs its days; days are bounded", () => {
        expect(QuoteTermsSchema.safeParse({ dealer_payment_terms: "credit" }).success).toBe(false);
        expect(QuoteTermsSchema.safeParse({ dealer_payment_terms: "credit", credit_days: 181 }).success).toBe(false);
        expect(QuoteTermsSchema.safeParse({ dealer_payment_terms: "credit", credit_days: 30 }).success).toBe(true);
        expect(QuoteTermsSchema.safeParse({ dealer_payment_terms: "finance" }).success).toBe(false);
    });

    it("formats and merges tolerantly", () => {
        expect(formatCreditTerms("credit", 60)).toBe("Credit — 60 days");
        expect(mergeStandardTerms(null)).toEqual(DEFAULT_STANDARD_TERMS);
        expect(mergeStandardTerms({ warranty: "  24 months ", delivery: "" })).toEqual({
            warranty: "24 months",
            delivery: DEFAULT_STANDARD_TERMS.delivery,
        });
    });
});
