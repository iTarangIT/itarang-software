/**
 * ID 205 (28 Oct, Kartik) — the OEM price never reaches the dealer.
 *
 * Every outward face of a quotation is rendered here from the same lines and
 * searched for the OEM figure:
 *   - the quotation PDF (snapshotListPrices -> buildQuotationView -> HTML)
 *   - the CEO approval-request and approved emails (salesperson is copied)
 *   - the dealer email and the WhatsApp document caption + buttons, and the
 *     internal notice a WhatsApp-only send emails to the CC list
 *
 * The OEM figure is deliberately odd (38,417) so no other number on the
 * documents can match it by accident.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendEmail, sendDocumentBytes, sendInteractive } = vi.hoisted(() => ({
    sendEmail: vi.fn(async (_args: Record<string, unknown>) => ({ messageId: "m1" })),
    sendDocumentBytes: vi.fn(async (..._args: unknown[]) => ({ ok: true, providerMessageId: "wa1" })),
    sendInteractive: vi.fn(async (..._args: unknown[]) => ({ ok: true })),
}));

vi.mock("@/lib/db", () => ({
    db: {
        // CEO / people lookups and the dispatch log all go through execute().
        execute: vi.fn(async () => [
            { id: "u1", name: "Ravi", email: "ravi@itarang.com", is_active: true, m_id: null },
        ]),
    },
}));
vi.mock("@/lib/users/reportingLines", () => ({ hasReportsToColumn: async () => false }));
vi.mock("@/lib/leads/quote-pdf/view-store", () => ({ loadLineTaxRefs: async () => new Map() }));
vi.mock("@/lib/email/mailer", () => ({ sendEmail }));
vi.mock("@/lib/email/downloadPdfBuffer", () => ({ downloadPdfBuffer: async () => Buffer.from("%PDF-1.4") }));
vi.mock("@/lib/whatsapp", () => ({ getAdapter: () => ({ sendDocumentBytes, sendInteractive }) }));
vi.mock("@/lib/leads/quoteToken", () => ({ quoteApprovalUrl: () => "https://app.itarang.com/q/tok" }));

import type { CommercialsProductLine } from "@/lib/inside-sales/types";
import { refKey } from "@/lib/leads/oemPricing";
import { snapshotListPrices, type ListPriceRef } from "@/lib/leads/listPrices";
import { DEFAULT_QUOTATION_CONFIG } from "@/lib/leads/quote-pdf/config";
import { renderProformaHtml } from "@/lib/leads/quote-pdf/proforma-template";
import { buildQuotationView } from "@/lib/leads/quote-pdf/view";
import { buildQuoteApprovalRequestEmail, buildQuoteApprovedEmail } from "@/lib/leads/quoteApprovalEmail";
import { dispatchQuotation, type DispatchQuotationInput } from "@/lib/leads/quoteDispatch";

const OEM = 38_417;
/** 38417, 38,417, 38417.00, 38,417.00 — any way the figure could be printed. */
const OEM_RE = /38,?417/;

const line = (id: string, unit_price: number): CommercialsProductLine => ({
    asset_type: "battery",
    product_id: id,
    product_name: `Battery ${id}`,
    model_id: `M-${id}`,
    unit_price,
    quantity: 2,
});

// "noList" has only an OEM price and is quoted BELOW it; "withList" has a
// CEO list price of 45,000 and is quoted below that.
const LIST_REFS = new Map<string, ListPriceRef>([
    [refKey("battery", "withList"), { price_id: "l1", list_price: 45_000 }],
]);

function pdfHtml(lines: CommercialsProductLine[]): string {
    const view = buildQuotationView({
        quoteNumber: "ITQ-2026-0205",
        quoteDate: new Date("2026-10-29T06:00:00.000Z"),
        config: DEFAULT_QUOTATION_CONFIG,
        lines: snapshotListPrices(lines, LIST_REFS),
        taxRefs: new Map(),
        placeOfSupply: { stateCode: "09", label: "Uttar Pradesh (09)" },
        dealer: { name: "Test Dealer", gstin: null },
    });
    return renderProformaHtml(view);
}

describe("ID 205 — quotation PDF", () => {
    it("no list price, quoted below OEM: only the rate, no List price, no discount, no OEM figure", () => {
        const html = pdfHtml([line("noList", 36_000)]);
        expect(html).not.toMatch(OEM_RE);
        expect(html).not.toContain("List price");
        expect(html).not.toContain("Discount");
        expect(html).toContain("36,000.00");
    });

    it("with a list price, quoted below it: List price and discount show as before", () => {
        const html = pdfHtml([line("withList", 40_000)]);
        expect(html).toContain("List price");
        expect(html).toContain("Total discount");
        expect(html).toContain("45,000.00");
        expect(html).toContain("10,000.00"); // (45,000 − 40,000) × 2
    });

    it("mixed quote: the no-list-price line prints a dash, never the OEM figure", () => {
        const html = pdfHtml([line("withList", 40_000), line("noList", 36_000)]);
        expect(html).toContain("List price");
        expect(html).not.toMatch(OEM_RE);
    });

    it("a list_price the caller smuggled in (e.g. the OEM price) is overwritten", () => {
        const html = pdfHtml([{ ...line("noList", 36_000), list_price: OEM }]);
        expect(html).not.toMatch(OEM_RE);
        expect(html).not.toContain("List price");
    });
});

// Lines as they are stored after snapshotting, plus an oem_price field in case
// a caller ever passes a raw row through: neither email may print it.
const STORED = snapshotListPrices([line("withList", 40_000), line("noList", 36_000)], LIST_REFS).map((l) => ({
    ...l,
    oem_price: OEM,
})) as CommercialsProductLine[];

describe("ID 205 — quote emails", () => {
    const subject = { family: "lead" as const, dealerName: "Test Dealer", refId: "DL-1", versionNo: 2, lines: STORED };

    it("CEO approval-request email carries no OEM figure", async () => {
        const e = await buildQuoteApprovalRequestEmail({ ...subject, raisedBy: "u1", href: "/leads/DL-1" });
        expect(e.html).toContain("Battery noList");
        expect(e.html + e.text + e.subject).not.toMatch(OEM_RE);
    });

    it("approved email carries no OEM figure", async () => {
        const e = await buildQuoteApprovedEmail({
            ...subject,
            raisedBy: "u1",
            ownerId: null,
            quoteNumber: "ITQ-2026-0205",
            draftReady: true,
            href: "/leads/DL-1",
        });
        expect(e.html).toContain("Battery noList");
        expect(e.html + e.text + e.subject).not.toMatch(OEM_RE);
    });
});

describe("ID 205 — dealer email and WhatsApp quote", () => {
    const input: DispatchQuotationInput = {
        commercialId: "00000000-0000-0000-0000-000000000205",
        dealerLeadId: "DL-1",
        versionNo: 2,
        quoteNumber: "ITQ-2026-0205",
        pdfUrl: "s3://quotes/ITQ-2026-0205.pdf",
        dealerName: "Test Dealer",
        channels: ["email", "whatsapp"],
        email: "dealer@example.com",
        phone: "9876543210",
        cc: ["care@itarang.com"],
        quoteTotal: 160_480,
        senderName: "Ravi",
        sentBy: "u1",
    };

    /** Everything readable that left the building: email text/html/subject, WhatsApp caption + button body. */
    function sentText(): string {
        const emails = sendEmail.mock.calls.map(([a]) => `${a.subject} ${a.text} ${a.html}`);
        const docs = sendDocumentBytes.mock.calls.map((c) => String(c[4] ?? ""));
        const buttons = sendInteractive.mock.calls.map((c) => `${c[1]} ${JSON.stringify(c[2])}`);
        return [...emails, ...docs, ...buttons].join("\n");
    }

    beforeEach(() => {
        sendEmail.mockClear();
        sendDocumentBytes.mockClear();
        sendInteractive.mockClear();
    });

    it("email + WhatsApp send carries no OEM figure", async () => {
        const out = await dispatchQuotation(input);
        expect(out.map((o) => o.status)).toEqual(["sent", "sent"]);
        expect(sendEmail).toHaveBeenCalledTimes(1);
        expect(sendDocumentBytes).toHaveBeenCalledTimes(1);
        expect(sentText()).toContain("ITQ-2026-0205");
        expect(sentText()).not.toMatch(OEM_RE);
    });

    it("WhatsApp-only send and its internal notice email carry no OEM figure", async () => {
        const out = await dispatchQuotation({ ...input, channels: ["whatsapp"] });
        expect(out[0].ccNotice).toBe("sent");
        expect(sendEmail).toHaveBeenCalledTimes(1); // the internal notice
        expect(sentText()).not.toMatch(OEM_RE);
    });
});
