import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/touchpoints/write", () => ({ writeTouchpoint: vi.fn() }));
const { ownerWhatsAppNumber, quoteRejectedMessage } = await import("../quoteRejectedNotice");
const { leadMoveOnWithdraw } = await import("../withdrawQuote");
const { rollbackTarget } = await import("../quoteApproval");

// ID 135 — a CEO-rejected quote.

describe("the v1/v2 example from the tracker", () => {
    // Rep sends v1 (approved, Awaiting decision), raises v2 (pending), withdraws
    // v1; the CEO rejects v2. Nothing is left in play.
    const versions = [
        { commercial_id: "c1", version_no: 1, approval_status: "approved", withdrawn_at: "2026-10-03T10:00:00Z" },
        { commercial_id: "c2", version_no: 2, approval_status: "rejected", withdrawn_at: null },
    ];
    const inPlay = versions.filter((v) => ["approved", "pending"].includes(v.approval_status) && !v.withdrawn_at);

    it("does not restore the withdrawn v1 as current", () => {
        expect(rollbackTarget(versions, 2)).toBeNull();
    });

    it("sends the lead back to Under discussion", () => {
        expect(
            leadMoveOnWithdraw({ leadStatus: "Awaiting_Customer_Decision", preTransferStatus: null, quoteStillInPlay: inPlay.length > 0 }),
        ).toBe("back");
    });

    it("on a lead awaiting a field visit, lowers the saved stage instead", () => {
        expect(
            leadMoveOnWithdraw({
                leadStatus: "Transferred_to_ASM",
                preTransferStatus: "Awaiting_Customer_Decision",
                quoteStillInPlay: false,
            }),
        ).toBe("pre_transfer");
    });

    it("rejecting a revision while v1 is still live leaves the lead where it is", () => {
        expect(
            leadMoveOnWithdraw({ leadStatus: "Awaiting_Customer_Decision", preTransferStatus: null, quoteStillInPlay: true }),
        ).toBe("stay");
    });
});

describe("quoteRejectedMessage", () => {
    const base = {
        dealerName: "Shree Motors",
        quoteNumber: "Q-0042",
        versionNo: 2,
        value: 92000,
        reason: "Discount below floor",
        rejectorName: "Kartik",
        leadMove: "back" as const,
        liveVersionNo: null,
    };

    it("carries the CEO's reason and says where the lead now is", () => {
        const m = quoteRejectedMessage(base);
        expect(m).toContain("Kartik rejected quotation v2 Q-0042");
        expect(m).toContain("Shree Motors");
        expect(m).toContain("Reason: Discount below floor");
        expect(m).toMatch(/back at Under discussion/);
    });

    it("names the version still live when one is left", () => {
        expect(quoteRejectedMessage({ ...base, leadMove: "stay", liveVersionNo: 1 })).toMatch(/v1 is still the live quote/);
    });

    it("mentions the field visit for a lead awaiting one", () => {
        expect(quoteRejectedMessage({ ...base, leadMove: "pre_transfer" })).toMatch(/after the field visit/);
    });
});

describe("ownerWhatsAppNumber", () => {
    it("adds India's code to a 10-digit number and strips formatting", () => {
        expect(ownerWhatsAppNumber("98765 43210")).toBe("919876543210");
        expect(ownerWhatsAppNumber("+91 98765-43210")).toBe("919876543210");
        expect(ownerWhatsAppNumber("09876543210")).toBe("919876543210");
    });

    it("gives null for nothing usable", () => {
        expect(ownerWhatsAppNumber(null)).toBeNull();
        expect(ownerWhatsAppNumber("12345")).toBeNull();
    });
});
