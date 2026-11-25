import { describe, expect, it } from "vitest";
import { mayCreateAccountQuote, mayOpenAccountPage, mayViewAccountQuotes } from "../quotationAccess";
import { mayLogAccountVisit } from "@/lib/visits/verifiedCapture";
import { paymentReferenceProblem, normalizePaymentReference } from "@/lib/leads/wonPayment";

// 25 Nov item 9 — an ASM logs visits on any onboarded dealer.
describe("ASM on a dealer outside their team (item 9)", () => {
    const asm = { role: "asm", userId: "asm-1", ownerId: "isr-9", teamIds: ["isr-2"] };

    it("may log a visit — owned by someone else, or by nobody", () => {
        expect(mayLogAccountVisit({ userId: "asm-1", ownerId: "isr-9", teamIds: ["isr-2"], role: "asm" })).toBe(true);
        expect(mayLogAccountVisit({ userId: "asm-1", ownerId: null, teamIds: [], role: "asm" })).toBe(true);
    });

    it("may open the dealer page, but not read or raise its quotes", () => {
        expect(mayOpenAccountPage(asm)).toBe(true);
        expect(mayViewAccountQuotes(asm)).toBe(false);
        expect(mayCreateAccountQuote(asm)).toBe(false);
    });

    it("an ISR still logs only on their own (or nobody's-team) dealer", () => {
        expect(mayLogAccountVisit({ userId: "isr-1", ownerId: "isr-9", teamIds: [], role: "inside_sales_rep" })).toBe(false);
        expect(mayLogAccountVisit({ userId: "isr-1", ownerId: null, teamIds: [], role: "inside_sales_rep" })).toBe(false);
        expect(mayLogAccountVisit({ userId: "isr-1", ownerId: "isr-1", teamIds: [], role: "inside_sales_rep" })).toBe(true);
        expect(mayOpenAccountPage({ role: "inside_sales_rep", userId: "isr-1", ownerId: "isr-9" })).toBe(false);
    });
});

// 25 Nov items 6 + 7 — Won means paid: the payment reference.
describe("payment reference on Mark Won (item 7)", () => {
    it("is required and shape-checked", () => {
        expect(paymentReferenceProblem("")).toMatch(/Enter the payment reference/);
        expect(paymentReferenceProblem("12")).toMatch(/6 to 64/);
        expect(paymentReferenceProblem("UTR#123456")).toMatch(/Use only/);
        expect(paymentReferenceProblem("UTR 412345678901")).toBeNull();
        expect(paymentReferenceProblem("SBIN/2026-11/0042")).toBeNull();
    });
    it("is stored trimmed with spaces collapsed", () => {
        expect(normalizePaymentReference("  UTR   4123 ")).toBe("UTR 4123");
        expect(normalizePaymentReference("   ")).toBeNull();
    });
});
