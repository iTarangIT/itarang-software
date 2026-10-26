/**
 * E-358 — the document for an APPROVED account quotation. The account-keyed
 * twin of src/lib/leads/quoteDraft.ts: same proforma template, same tax and
 * place-of-supply rules, same render and upload — but billed to the dealer
 * ACCOUNT (accounts row), numbered in its own "<prefix>A" series, and written
 * back to account_quotations. Idempotent, and run only after the approval has
 * committed (see quoteDraft.ts for why).
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import type { CommercialsProductLine } from "@/lib/inside-sales/types";
import { renderPdfFromHtml } from "@/lib/pdf/render-html";
import { uploadFileToStorage } from "@/lib/storage";
import { resolveQuotationConfig } from "@/lib/leads/quote-pdf/config-store";
import { quoteNumberForVersion, quoteNumberRoot } from "@/lib/leads/quote-pdf/numbering";
import { renderProformaHtml } from "@/lib/leads/quote-pdf/proforma-template";
import { buildQuotationView, composeBillToAddress } from "@/lib/leads/quote-pdf/view";
import { resolvePlaceOfSupply } from "@/lib/leads/quote-pdf/gst-states";
import { loadLineTaxRefs } from "@/lib/leads/quote-pdf/view-store";
import { nextQuoteNumber, QuotationDraftError } from "@/lib/leads/quoteDraft";
import { formatCreditTerms } from "@/lib/leads/quoteTermsRules";

export interface AccountQuotationDraft {
    quotation_id: string;
    quote_number: string;
    quote_pdf_url: string;
    generated: boolean;
}

type Row = {
    quotation_id: string;
    account_id: string;
    version_no: number;
    approval_status: string;
    product_lines: unknown;
    quote_number: string | null;
    quote_pdf_url: string | null;
    payment_method: string | null;
    dealer_payment_terms: string | null;
    credit_days: number | null;
    credit_terms: string | null;
    delivery_terms: string | null;
    warranty_terms: string | null;
    notes: string | null;
    name: string | null;
    gstin: string | null;
    address_line1: string | null;
    address_line2: string | null;
    city: string | null;
    state: string | null;
    pincode: string | null;
    contact_phone: string | null;
};

/** One root per account's chain, like a lead's; the series is "<prefix>A" so it never reads as a lead quote. */
async function allocateNumber(accountId: string, versionNo: number, prefix: string, at: Date): Promise<string> {
    const prior = (await db.execute(sql`
        SELECT quote_number FROM account_quotations
         WHERE account_id = ${accountId} AND quote_number IS NOT NULL
         ORDER BY version_no ASC LIMIT 1
    `)) as unknown as Array<{ quote_number: string }>;
    const root = prior[0]?.quote_number
        ? quoteNumberRoot(prior[0].quote_number)
        : await nextQuoteNumber(`${prefix}A`, at);
    return quoteNumberForVersion(root, versionNo);
}

export async function generateAccountQuotationDraft(
    quotationId: string,
    options: { force?: boolean; at?: Date } = {},
): Promise<AccountQuotationDraft> {
    const at = options.at ?? new Date();
    const rows = (await db.execute(sql`
        SELECT q.quotation_id::text AS quotation_id, q.account_id, q.version_no, q.approval_status,
               q.product_lines, q.quote_number, q.quote_pdf_url, q.payment_method,
               q.dealer_payment_terms, q.credit_days, q.credit_terms, q.delivery_terms,
               q.warranty_terms, q.notes,
               a.business_entity_name AS name, a.gstin, a.address_line1, a.address_line2,
               a.city, a.state, a.pincode, a.contact_phone
          FROM account_quotations q
          LEFT JOIN accounts a ON a.id = q.account_id
         WHERE q.quotation_id = ${quotationId}::uuid
         LIMIT 1
    `)) as unknown as Row[];
    const row = rows[0];
    if (!row) throw new QuotationDraftError("NOT_FOUND", "Quotation not found.");
    if (row.approval_status !== "approved") {
        throw new QuotationDraftError("NOT_APPROVED", `Cannot draft a quotation that is ${row.approval_status}.`);
    }
    if (row.quote_pdf_url && row.quote_number && !options.force) {
        return { quotation_id: row.quotation_id, quote_number: row.quote_number, quote_pdf_url: row.quote_pdf_url, generated: false };
    }

    const lines: CommercialsProductLine[] = Array.isArray(row.product_lines)
        ? (row.product_lines as CommercialsProductLine[])
        : [];
    const config = await resolveQuotationConfig();
    const quoteNumber = row.quote_number ?? (await allocateNumber(row.account_id, row.version_no, config.numberPrefix, at));

    const view = buildQuotationView({
        quoteNumber,
        quoteDate: at,
        config,
        lines,
        taxRefs: await loadLineTaxRefs(lines),
        placeOfSupply: resolvePlaceOfSupply(row.state, row.gstin),
        dealer: {
            name: row.name,
            gstin: row.gstin,
            addressLines: composeBillToAddress({
                location: row.address_line1,
                area: row.address_line2,
                city: row.city,
                state: row.state,
                pincode: row.pincode,
            }),
            phone: row.contact_phone,
        },
        commercialTerms: {
            paymentMethod: row.dealer_payment_terms
                ? formatCreditTerms(row.dealer_payment_terms === "credit" ? "credit" : "cash", row.credit_days)
                : row.payment_method,
            onboardingFee: null,
            creditTerms: null,
            deliveryTerms: row.delivery_terms,
            warranty: row.warranty_terms,
            dealNotes: row.notes,
        },
    });

    const pdf = await renderPdfFromHtml(renderProformaHtml(view));
    const { url } = await uploadFileToStorage({
        fileBuffer: pdf,
        fileName: `${quoteNumber}.pdf`,
        folder: "quotations",
        contentType: "application/pdf",
    });

    // ISO string, never a Date, in a raw sql`` template (see quoteDraft.ts).
    await db.execute(sql`
        UPDATE account_quotations
           SET quote_number = ${quoteNumber}, quote_pdf_url = ${url},
               quote_pdf_generated_at = ${at.toISOString()}, quote_pdf_error = NULL,
               quote_snapshot = ${JSON.stringify(view)}::jsonb, updated_at = NOW()
         WHERE quotation_id = ${quotationId}::uuid
    `);
    return { quotation_id: row.quotation_id, quote_number: quoteNumber, quote_pdf_url: url, generated: true };
}

/** Generate and never throw — a failure lands in quote_pdf_error ("retry" on the page). */
export async function tryGenerateAccountQuotationDraft(
    quotationId: string,
    options: { force?: boolean } = {},
): Promise<AccountQuotationDraft | null> {
    try {
        return await generateAccountQuotationDraft(quotationId, options);
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error("[accountQuoteDraft] generation failed", { quotationId, message });
        try {
            await db.execute(sql`
                UPDATE account_quotations SET quote_pdf_error = ${message.slice(0, 2000)}, updated_at = NOW()
                 WHERE quotation_id = ${quotationId}::uuid
            `);
        } catch (inner) {
            console.error("[accountQuoteDraft] could not record the failure either", inner);
        }
        return null;
    }
}
