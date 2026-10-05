import { describe, expect, it } from "vitest";
import { isLiveQuoteVersion, pickLiveQuote, pickPendingQuote, type QuoteVersionLike } from "../liveQuote";

function row(version_no: number, over: Partial<QuoteVersionLike> = {}): QuoteVersionLike & { id: string } {
    return {
        id: `v${version_no}`,
        version_no,
        event_type: "quote_issue",
        approval_status: "approved",
        withdrawn_at: null,
        ...over,
    };
}

describe("pickLiveQuote — the quote the dealer can answer and the rep can send (ID 60 / 61)", () => {
    it("a live quote is a quote, approved, not withdrawn", () => {
        expect(isLiveQuoteVersion(row(1))).toBe(true);
        expect(isLiveQuoteVersion(row(1, { event_type: "quote_revision" }))).toBe(true);
        expect(isLiveQuoteVersion(row(1, { approval_status: "pending" }))).toBe(false);
        expect(isLiveQuoteVersion(row(1, { approval_status: "rejected" }))).toBe(false);
        // The server gate requires 'approved' exactly; a pre-gate NULL is not offered.
        expect(isLiveQuoteVersion(row(1, { approval_status: null }))).toBe(false);
        expect(isLiveQuoteVersion(row(1, { withdrawn_at: "2026-10-01" }))).toBe(false);
        for (const event_type of ["final_terms", "terms_update", "brochure_share"]) {
            expect(isLiveQuoteVersion(row(1, { event_type })), event_type).toBe(false);
        }
    });

    it("final terms / terms update / brochure after a quote: the quote stays live (ID 61)", () => {
        for (const event_type of ["final_terms", "terms_update", "brochure_share"]) {
            const history = [row(2, { event_type }), row(1)];
            expect(pickLiveQuote(history)?.id, event_type).toBe("v1");
        }
    });

    it("a revision waiting for the CEO, rejected or withdrawn replaces nothing (ID 60)", () => {
        expect(pickLiveQuote([row(2, { event_type: "quote_revision", approval_status: "pending" }), row(1)])?.id).toBe("v1");
        expect(pickLiveQuote([row(2, { event_type: "quote_revision", approval_status: "rejected" }), row(1)])?.id).toBe("v1");
        expect(pickLiveQuote([row(2, { event_type: "quote_revision", withdrawn_at: "2026-10-01" }), row(1)])?.id).toBe("v1");
    });

    it("an approved revision replaces the older quote, whatever order the rows arrive in", () => {
        expect(pickLiveQuote([row(1), row(3, { event_type: "quote_revision" }), row(2)])?.id).toBe("v3");
    });

    it("no live quote → null", () => {
        expect(pickLiveQuote([])).toBeNull();
        expect(pickLiveQuote([row(1, { approval_status: "pending" }), row(2, { event_type: "final_terms" })])).toBeNull();
        expect(pickLiveQuote([row(1, { withdrawn_at: "2026-10-01" })])).toBeNull();
    });
});

describe("pickPendingQuote — the quote at the CEO that the rep can still withdraw (ID 78)", () => {
    it("a pending revision under a terms row is still found", () => {
        const history = [row(3, { event_type: "terms_update" }), row(2, { event_type: "quote_revision", approval_status: "pending" }), row(1)];
        expect(pickPendingQuote(history)?.id).toBe("v2");
        expect(pickLiveQuote(history)?.id).toBe("v1");
    });

    it("approved, rejected, withdrawn and non-quote rows are not pending", () => {
        expect(pickPendingQuote([row(1)])).toBeNull();
        expect(pickPendingQuote([row(1, { approval_status: "rejected" })])).toBeNull();
        expect(pickPendingQuote([row(1, { approval_status: "pending", withdrawn_at: "2026-10-01" })])).toBeNull();
        expect(pickPendingQuote([row(1, { event_type: "final_terms", approval_status: "pending" })])).toBeNull();
    });
});
