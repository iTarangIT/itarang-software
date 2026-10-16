import { describe, expect, it } from "vitest";
import { dealCardAsked, decideDealerOnboarded, shortDay } from "@/lib/leads/dealerOnboardedRules";

const invoice = { invoiceNumber: "ITG/202627/034", invoiceDate: "2026-08-08", via: "gstin" as const };
const approved = { applicationId: "app-1", company: "SHARDA ENTERPRISES", approvedAt: "2026-08-03T10:00:00Z", via: "phone" as const };

describe("decideDealerOnboarded (ID 186)", () => {
    it("a new dealer — nothing on record — is not onboarded", () => {
        const v = decideDealerOnboarded({ approvedOnboarding: null, batteryInvoice: null });
        expect(v.onboarded).toBe(false);
        expect(v.reason).toMatch(/New dealer/);
    });

    it("an earlier battery invoice alone makes the dealer onboarded (Sharda Enterprises)", () => {
        const v = decideDealerOnboarded({ approvedOnboarding: null, batteryInvoice: invoice });
        expect(v.onboarded).toBe(true);
        expect(v.reason).toBe("Already onboarded: battery invoice ITG/202627/034 on 8 Aug 2026.");
    });

    it("an approved onboarding alone makes the dealer onboarded, and is the reason shown first", () => {
        const v = decideDealerOnboarded({ approvedOnboarding: approved, batteryInvoice: invoice });
        expect(v.onboarded).toBe(true);
        expect(v.reason).toBe("Already onboarded: approved onboarding (SHARDA ENTERPRISES) on 3 Aug 2026.");
        expect(v.batteryInvoice).toEqual(invoice);
    });

    it("a dealer account counts as an approved onboarding", () => {
        const v = decideDealerOnboarded({
            approvedOnboarding: { applicationId: null, company: "Acme", approvedAt: null, via: "account" },
            batteryInvoice: null,
        });
        expect(v.onboarded).toBe(true);
        expect(v.reason).toBe("Already onboarded: dealer account (Acme).");
    });

    it("a failed check asks for the card (the pre-ID-186 behaviour)", () => {
        const v = decideDealerOnboarded({ approvedOnboarding: null, batteryInvoice: null, checkFailed: true });
        expect(v.onboarded).toBe(false);
        expect(v.reason).toMatch(/Could not check/);
    });
});

describe("dealCardAsked", () => {
    it("asks on a quote issue / revision for a dealer not onboarded", () => {
        expect(dealCardAsked("quote_issue", { onboarded: false })).toBe(true);
        expect(dealCardAsked("quote_revision", null)).toBe(true);
    });
    it("never asks for an onboarded dealer, nor on other events", () => {
        expect(dealCardAsked("quote_issue", { onboarded: true })).toBe(false);
        expect(dealCardAsked("terms_update", { onboarded: false })).toBe(false);
        expect(dealCardAsked("brochure_share", { onboarded: false })).toBe(false);
    });
});

describe("shortDay", () => {
    it("formats a date or timestamp, and rejects junk", () => {
        expect(shortDay("2026-09-12")).toBe("12 Sep 2026");
        expect(shortDay("2026-01-05T23:00:00Z")).toBe("5 Jan 2026");
        expect(shortDay(null)).toBeNull();
        expect(shortDay("12/09/2026")).toBeNull();
    });
});
