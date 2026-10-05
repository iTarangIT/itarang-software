import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/touchpoints/write", () => ({ writeTouchpoint: vi.fn() }));
const { leadMoveOnWithdraw, withdrawRefusal } = await import("../withdrawQuote");
type Q = Parameters<typeof withdrawRefusal>[0];

const quote = (over: Partial<Q> = {}): Q => ({
    event_type: "quote_issue",
    approval_status: "approved",
    dealer_decision: null,
    withdrawn_at: null,
    lead_status: "Awaiting_Customer_Decision",
    ...over,
});

describe("withdrawRefusal — which quotes can be withdrawn (ID 78)", () => {
    it("an approved quote, and one still waiting for the CEO, can be withdrawn", () => {
        expect(withdrawRefusal(quote())).toBeNull();
        expect(withdrawRefusal(quote({ approval_status: "pending" }))).toBeNull();
        expect(withdrawRefusal(quote({ event_type: "quote_revision" }))).toBeNull();
        // A dealer's "no" does not close the quote on our side.
        expect(withdrawRefusal(quote({ dealer_decision: "declined" }))).toBeNull();
    });

    it("a quote the dealer approved cannot — Mark Won / Mark Lost close it", () => {
        const r = withdrawRefusal(quote({ dealer_decision: "approved", lead_status: "Commercials_Finalised" }));
        expect(r?.status).toBe(409);
        expect(r?.message).toMatch(/Mark the lead Won or Lost/);
    });

    it("already withdrawn, rejected, or not a quote at all", () => {
        expect(withdrawRefusal(quote({ withdrawn_at: "2026-10-01" }))?.message).toMatch(/already withdrawn/);
        expect(withdrawRefusal(quote({ approval_status: "rejected" }))?.message).toMatch(/rejected by the CEO/);
        for (const event_type of ["final_terms", "terms_update", "brochure_share"]) {
            expect(withdrawRefusal(quote({ event_type })), event_type).toMatchObject({ status: 400 });
        }
    });

    it("a closed lead's quote cannot be withdrawn", () => {
        for (const lead_status of ["Won", "Converted", "Lost"]) {
            expect(withdrawRefusal(quote({ lead_status }))?.message, lead_status).toMatch(new RegExp(`lead is ${lead_status}`));
        }
    });

    it("on a Commercials finalised lead, an un-approved newer revision can still be withdrawn (the lead stays put)", () => {
        expect(withdrawRefusal(quote({ lead_status: "Commercials_Finalised" }))).toBeNull();
    });
});

describe("leadMoveOnWithdraw — the lead goes back only when no quote is left in play (ID 78)", () => {
    const at = (leadStatus: string, quoteStillInPlay: boolean, preTransferStatus: string | null = null) =>
        leadMoveOnWithdraw({ leadStatus, preTransferStatus, quoteStillInPlay });

    it("last quote withdrawn → back to Under discussion", () => {
        expect(at("Commercials_Explained", false)).toBe("back");
        expect(at("Awaiting_Customer_Decision", false)).toBe("back");
    });

    it("an old v1 withdrawn while v2 is live, or a pending revision while v1 is live → the lead stays", () => {
        expect(at("Commercials_Explained", true)).toBe("stay");
        expect(at("Awaiting_Customer_Decision", true)).toBe("stay");
        expect(at("Transferred_to_ASM", true, "Awaiting_Customer_Decision")).toBe("stay");
    });

    it("never out of Commercials finalised", () => {
        expect(at("Commercials_Finalised", false)).toBe("stay");
        expect(at("Transferred_to_ASM", false, "Commercials_Finalised")).toBe("stay");
    });

    it("awaiting a field visit: the stage the visit will restore is lowered instead", () => {
        expect(at("Transferred_to_ASM", false, "Awaiting_Customer_Decision")).toBe("pre_transfer");
        expect(at("Transferred_to_ASM", false, "Commercials_Explained")).toBe("pre_transfer");
        expect(at("Transferred_to_ASM", false, "Under_Discussion")).toBe("stay");
        expect(at("Transferred_to_ASM", false, null)).toBe("stay");
    });

    it("a lead not at a commercials stage has nothing to move", () => {
        expect(at("Under_Discussion", false)).toBe("stay");
        expect(at("Assigned_Not_Contacted", false)).toBe("stay");
    });
});
