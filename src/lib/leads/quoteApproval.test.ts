import { describe, expect, it } from "vitest";
import {
    GATED_QUOTE_EVENTS,
    initialApprovalStatus,
    isGatedQuoteEvent,
    rollbackTarget,
} from "./quoteApproval";

// E-221 gated lead quotations behind CEO approval. The rules worth pinning are
// which events are gated, and — the one that can silently corrupt a lead — what
// becomes current again when a quote is rejected.

describe("which events are gated", () => {
    it("gates both quote events", () => {
        expect(isGatedQuoteEvent("quote_issue")).toBe(true);
        expect(isGatedQuoteEvent("quote_revision")).toBe(true);
        expect([...GATED_QUOTE_EVENTS]).toEqual(["quote_issue", "quote_revision"]);
    });

    // Gating these would stall routine follow-up behind the CEO's queue for no
    // commercial gain — brochure_share carries no price at all.
    it("leaves the non-quote events alone", () => {
        for (const e of ["brochure_share", "terms_update", "final_terms"]) {
            expect(isGatedQuoteEvent(e), e).toBe(false);
            expect(initialApprovalStatus(e), e).toBe("approved");
        }
    });

    it("starts a gated event pending", () => {
        expect(initialApprovalStatus("quote_issue")).toBe("pending");
        expect(initialApprovalStatus("quote_revision")).toBe("pending");
    });

    // An unknown event type must not become an unapproved live quote.
    it("treats an unknown event as ungated", () => {
        expect(initialApprovalStatus("something_new")).toBe("approved");
    });
});

describe("rollbackTarget", () => {
    const v = (version_no: number, approval_status: string | null) => ({
        commercial_id: `c${version_no}`,
        version_no,
        approval_status,
    });

    it("restores the newest approved version below the rejected one", () => {
        const target = rollbackTarget(
            [v(1, "approved"), v(2, "approved"), v(3, "pending")],
            3,
        );
        expect(target?.version_no).toBe(2);
    });

    // A version that was already refused must not come back as live just
    // because a later one was refused too.
    it("skips a rejected version", () => {
        const target = rollbackTarget(
            [v(1, "approved"), v(2, "rejected"), v(3, "pending")],
            3,
        );
        expect(target?.version_no).toBe(1);
    });

    // The dangerous case: rejecting v3 must not promote an unapproved v2 to
    // live, which would put a number in front of a dealer nobody signed off.
    it("skips a still-pending version", () => {
        const target = rollbackTarget(
            [v(1, "approved"), v(2, "pending"), v(3, "pending")],
            3,
        );
        expect(target?.version_no).toBe(1);
    });

    // Pre-E-221 rows carry NULL and are approved by definition.
    it("treats a null status as approved", () => {
        expect(rollbackTarget([v(1, null), v(2, "pending")], 2)?.version_no).toBe(1);
    });

    // A lead whose very first quote is rejected genuinely has no current
    // commercials. Inventing one would be worse than none.
    it("returns null when nothing qualifies", () => {
        expect(rollbackTarget([v(1, "pending")], 1)).toBeNull();
        expect(rollbackTarget([v(1, "rejected"), v(2, "pending")], 2)).toBeNull();
        expect(rollbackTarget([], 1)).toBeNull();
    });

    it("never selects a version above the rejected one", () => {
        const target = rollbackTarget(
            [v(1, "approved"), v(2, "pending"), v(3, "approved")],
            2,
        );
        expect(target?.version_no).toBe(1);
    });

    it("does not depend on input ordering", () => {
        const shuffled = [v(3, "pending"), v(1, "approved"), v(2, "approved")];
        expect(rollbackTarget(shuffled, 3)?.version_no).toBe(2);
    });
});
