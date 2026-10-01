// Shared reads for the quote tools (product_catalogue, quote_status,
// create_quote, send_quote): the catalogue WITHOUT prices, and a lead's current
// quote as an allowlisted projection.
//
// The OEM reference price is the approval floor, set by the CEO. It is never
// projected into anything a rep sees here — a quote's preview says only
// whether it will auto-approve or wait for the CEO.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { listOemCatalogue, type OemAssetType } from "@/lib/leads/oemPrices";
import type { CommercialsProductLine } from "@/lib/inside-sales/types";
import type { ProductSummary } from "../types";

/** One catalogue product as a tool hands it back — no price. */
export type CatalogueProduct = ProductSummary;

/** Every active product across the three masters, price stripped. */
export async function loadCatalogue(): Promise<CatalogueProduct[]> {
    const rows = await listOemCatalogue();
    return rows.map((r) => ({
        product_id: r.product_id,
        asset_type: r.asset_type,
        product_name: r.product_name,
        model_id: r.model_id,
        detail: r.detail,
    }));
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9.]+/g, " ").trim();

/**
 * Catalogue rows matching every word of `query` (name, model or detail), or all
 * of them for an empty query. "51.2v 105ah" finds "LFP 51.2V 105Ah".
 */
export function filterCatalogue(
    rows: CatalogueProduct[],
    query: string | null | undefined,
    assetType?: OemAssetType | null,
): CatalogueProduct[] {
    const words = norm(query ?? "").split(" ").filter(Boolean);
    return rows.filter((r) => {
        if (assetType && r.asset_type !== assetType) return false;
        if (words.length === 0) return true;
        const hay = norm(`${r.product_name} ${r.model_id} ${r.detail ?? ""} ${r.asset_type}`);
        return words.every((w) => hay.includes(w));
    });
}

/** A lead's quote row, projected — never the raw row (no oem_evaluation). */
export type QuoteView = {
    commercial_id: string;
    version_no: number;
    event_type: string;
    approval_status: string | null;
    approval_mode: string | null;
    rejection_reason: string | null;
    total: number | null;
    quote_number: string | null;
    pdf_ready: boolean;
    product_lines: { product_id: string; asset_type: string; product_name: string; quantity: number; unit_price: number | null }[];
    credit_terms: string | null;
    delivery_terms: string | null;
    warranty_terms: string | null;
    payment_method: string | null;
    deal_notes: string | null;
    dealer_decision: string | null;
    dealer_decision_at: string | null;
    created_at: string | null;
};

type QuoteDbRow = {
    commercial_id: string;
    version_no: number;
    event_type: string;
    approval_status: string | null;
    approval_mode: string | null;
    rejection_reason: string | null;
    total: string | null;
    quote_number: string | null;
    quote_pdf_url: string | null;
    product_lines: CommercialsProductLine[] | null;
    credit_terms: string | null;
    delivery_terms: string | null;
    warranty_terms: string | null;
    payment_method: string | null;
    deal_notes: string | null;
    dealer_decision: string | null;
    dealer_decision_at: string | Date | null;
    created_at: string | Date | null;
};

/** Postgres timestamps come back as "2026-09-19 08:35:08.84+00" — hand the model ISO. */
export function pgIso(v: string | Date | null): string | null {
    if (v == null) return null;
    const d = v instanceof Date ? v : new Date(String(v).replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));
    return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}

function toView(r: QuoteDbRow): QuoteView {
    const total = r.total == null ? null : Number(r.total);
    return {
        commercial_id: r.commercial_id,
        version_no: Number(r.version_no),
        event_type: r.event_type,
        approval_status: r.approval_status,
        approval_mode: r.approval_mode,
        rejection_reason: r.rejection_reason,
        total: total != null && Number.isFinite(total) ? total : null,
        quote_number: r.quote_number,
        pdf_ready: !!r.quote_pdf_url,
        product_lines: (r.product_lines ?? []).map((l) => ({
            product_id: l.product_id,
            asset_type: l.asset_type,
            product_name: l.product_name,
            quantity: l.quantity,
            unit_price: l.unit_price,
        })),
        credit_terms: r.credit_terms,
        delivery_terms: r.delivery_terms,
        warranty_terms: r.warranty_terms,
        payment_method: r.payment_method,
        deal_notes: r.deal_notes,
        dealer_decision: r.dealer_decision,
        dealer_decision_at: pgIso(r.dealer_decision_at),
        created_at: pgIso(r.created_at),
    };
}

/**
 * The lead's latest QUOTE (quote_issue / quote_revision) — the row a send or a
 * revision is about. Not simply is_current: a later terms_update or brochure
 * share becomes current without being a quote. Rejected quotes are rolled back
 * by the CEO decision route, so the latest one is still the one to report.
 */
export async function loadLatestQuote(leadId: string): Promise<QuoteView | null> {
    const rows = await db.execute<QuoteDbRow>(sql`
        SELECT commercial_id::text AS commercial_id, version_no, event_type, approval_status,
               approval_mode, rejection_reason,
               COALESCE((quote_snapshot->>'total')::numeric, final_price, price_quoted)::text AS total,
               quote_number, quote_pdf_url, product_lines, credit_terms, delivery_terms,
               warranty_terms, payment_method, deal_notes, dealer_decision, dealer_decision_at, created_at
          FROM dealer_lead_commercials
         WHERE dealer_lead_id = ${leadId}
           AND event_type IN ('quote_issue', 'quote_revision')
           AND withdrawn_at IS NULL
         ORDER BY version_no DESC
         LIMIT 1
    `);
    const r = rows[0];
    return r ? toView(r) : null;
}

/** "₹42,000" — whole rupees unless there are paise. */
export function inr(n: number): string {
    return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

export const EVENT_LABEL: Record<string, string> = {
    quote_issue: "Quote",
    quote_revision: "Revised quote",
};

export const APPROVAL_LABEL: Record<string, string> = {
    approved: "Approved",
    pending: "Waiting for CEO approval",
    rejected: "Rejected by CEO",
};
