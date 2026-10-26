import { describe, expect, it } from "vitest";

import {
    accountInQuoteScope,
    mayCreateAccountQuote,
    mayViewAccountQuotes,
    myDealersScope,
} from "@/lib/accounts/quotationAccess";

const SONU = "sonu-asm";
const ASSOC = "associate-isr";
const OTHER = "other-isr";

describe("account quotation access (E-356, 24 Oct items 8 + 11)", () => {
    it("an ISR quotes only the account they own", () => {
        expect(mayCreateAccountQuote({ role: "inside_sales_rep", userId: ASSOC, ownerId: ASSOC })).toBe(true);
        expect(mayCreateAccountQuote({ role: "inside_sales_rep", userId: OTHER, ownerId: ASSOC })).toBe(false);
    });

    it("an ISR's team list never widens their scope", () => {
        expect(
            mayCreateAccountQuote({ role: "inside_sales_rep", userId: OTHER, ownerId: ASSOC, teamIds: [ASSOC] }),
        ).toBe(false);
    });

    it("an ASM quotes their own account and their direct reports' accounts", () => {
        expect(mayCreateAccountQuote({ role: "asm", userId: SONU, ownerId: SONU })).toBe(true);
        expect(mayCreateAccountQuote({ role: "asm", userId: SONU, ownerId: ASSOC, teamIds: [ASSOC] })).toBe(true);
    });

    it("an ASM cannot quote an account outside their team", () => {
        expect(mayCreateAccountQuote({ role: "asm", userId: SONU, ownerId: OTHER, teamIds: [ASSOC] })).toBe(false);
    });

    it("an account with no owner is open only to the any-account roles", () => {
        expect(mayCreateAccountQuote({ role: "asm", userId: SONU, ownerId: null, teamIds: [ASSOC] })).toBe(false);
        expect(mayCreateAccountQuote({ role: "sales_head", userId: "h", ownerId: null })).toBe(true);
    });

    it("Sales Head, CEO and Partner quote any account", () => {
        for (const role of ["sales_head", "ceo", "partner"]) {
            expect(mayCreateAccountQuote({ role, userId: "x", ownerId: ASSOC })).toBe(true);
        }
    });

    it("Admin sees every account's quotations but is not a quotation creator", () => {
        expect(mayCreateAccountQuote({ role: "admin", userId: "a", ownerId: "a" })).toBe(false);
        expect(mayViewAccountQuotes({ role: "admin", userId: "a", ownerId: ASSOC })).toBe(true);
    });

    it("other roles are refused, even as the owner", () => {
        for (const role of ["sales_executive", "sales_manager", "finance_controller", "dealer", "", null]) {
            expect(accountInQuoteScope({ role, userId: ASSOC, ownerId: ASSOC })).toBe(false);
            expect(mayViewAccountQuotes({ role, userId: ASSOC, ownerId: ASSOC })).toBe(false);
        }
    });

    it("a missing user id never matches a missing owner", () => {
        expect(mayCreateAccountQuote({ role: "inside_sales_rep", userId: null, ownerId: null })).toBe(false);
    });

    it("My Dealers lists all / team / own accounts by role", () => {
        expect(myDealersScope("ceo")).toBe("all");
        expect(myDealersScope("partner")).toBe("all");
        expect(myDealersScope("sales_head")).toBe("all");
        expect(myDealersScope("asm")).toBe("team");
        expect(myDealersScope("inside_sales_rep")).toBe("own");
        expect(myDealersScope("sales_manager")).toBe("own");
    });
});
