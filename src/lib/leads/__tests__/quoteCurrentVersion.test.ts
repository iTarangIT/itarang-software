/**
 * ID 60 — the dealer answers, and the rep sends, only the CURRENT quote version.
 *
 * The SQL that picks "current" (the newest approved, not-withdrawn quote
 * version — LIVE_QUOTE_VERSION) is covered against a real database by
 * scripts/verify-quote-current-version.ts. These tests pin what the two gates
 * DO with that answer, without a database.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/notifications/events", () => ({ notifyQuotationDealerDecision: vi.fn() }));
vi.mock("@/lib/touchpoints/write", () => ({ writeTouchpoint: vi.fn() }));
vi.mock("@/lib/leads/quoteStatus", () => ({ advanceLeadOnQuoteEvent: vi.fn() }));

const { staleQuoteReason } = await import("../quoteDecision");
// Annotated: an assertion function must be called through an explicitly typed name.
const gate: typeof import("../quoteSendGate") = await import("../quoteSendGate");
const { QuotationNotSendableError, LIVE_QUOTE_VERSION } = gate;

const V1 = "com-v1";
const V2 = "com-v2";

describe("staleQuoteReason — may the dealer answer this version?", () => {
    it("the current version is answerable", () => {
        expect(staleQuoteReason({ commercial_id: V2, withdrawn_at: null, latest_commercial_id: V2 })).toBeNull();
    });

    it("a different current version → replaced", () => {
        expect(staleQuoteReason({ commercial_id: V1, withdrawn_at: null, latest_commercial_id: V2 })).toBe("replaced");
    });

    it("v2 pending / rejected / withdrawn: the loader names v1 as current, so v1 stays answerable", () => {
        // What loadQuotationForDealer returns for v1 in those three cases: the
        // newer row is not live, so the current version is still v1 itself.
        expect(staleQuoteReason({ commercial_id: V1, withdrawn_at: null, latest_commercial_id: V1 })).toBeNull();
    });

    it("withdrawn wins over everything", () => {
        expect(staleQuoteReason({ commercial_id: V1, withdrawn_at: "2026-10-01", latest_commercial_id: V1 })).toBe("withdrawn");
        expect(staleQuoteReason({ commercial_id: V1, withdrawn_at: "2026-10-01", latest_commercial_id: V2 })).toBe("withdrawn");
    });

    it("no current version at all is not 'replaced' — the approval check refuses it instead", () => {
        expect(staleQuoteReason({ commercial_id: V1, withdrawn_at: null, latest_commercial_id: null })).toBeNull();
    });
});

function sendRow(over: Record<string, unknown> = {}) {
    return {
        commercial_id: V1,
        dealer_lead_id: "DL-1",
        approval_status: "approved",
        quote_number: "ITQ-2026-0001",
        quote_pdf_url: "/api/files/quotes/q.pdf",
        quote_pdf_error: null,
        version_no: 1,
        dealer_name: "A Traders",
        dealer_phone: "9999999999",
        dealer_email: null,
        quote_total: "50000",
        dealer_decision: null,
        dealer_decision_at: null,
        dealer_decision_via: null,
        dealer_decision_note: null,
        withdrawn_at: null,
        is_latest_quote: true,
        ...over,
    } as Parameters<typeof gate.assertSendable>[0];
}

function reasonOf(row: Parameters<typeof gate.assertSendable>[0]): string | null {
    try {
        gate.assertSendable(row);
        return null;
    } catch (e) {
        if (e instanceof QuotationNotSendableError) return e.reason;
        throw e;
    }
}

describe("assertSendable — may the rep send this version?", () => {
    it("the current approved version with a PDF goes", () => {
        expect(reasonOf(sendRow())).toBeNull();
    });

    it("an approved v1 can be re-sent while a newer version is not live (is_latest_quote stays true)", () => {
        expect(reasonOf(sendRow({ is_latest_quote: true }))).toBeNull();
    });

    it("replaced by a newer approved version → stale", () => {
        expect(reasonOf(sendRow({ is_latest_quote: false }))).toBe("stale");
    });

    it("withdrawn → stale; pending / rejected → not_approved; no PDF → no_draft; missing → not_found", () => {
        expect(reasonOf(sendRow({ withdrawn_at: "2026-10-01" }))).toBe("stale");
        expect(reasonOf(sendRow({ approval_status: "pending" }))).toBe("not_approved");
        expect(reasonOf(sendRow({ approval_status: "rejected" }))).toBe("not_approved");
        expect(reasonOf(sendRow({ quote_pdf_url: null }))).toBe("no_draft");
        expect(reasonOf(null)).toBe("not_found");
    });
});

describe("LIVE_QUOTE_VERSION — one definition of a version a dealer could be answering", () => {
    it("is a quote, approved, and not withdrawn", () => {
        const text = JSON.stringify(LIVE_QUOTE_VERSION);
        expect(text).toContain("quote_issue");
        expect(text).toContain("quote_revision");
        expect(text).toContain("q.approval_status = 'approved'");
        expect(text).toContain("q.withdrawn_at IS NULL");
    });
});
