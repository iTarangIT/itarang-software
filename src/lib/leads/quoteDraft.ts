/**
 * E-242 — turning an APPROVED quote into the document that goes to the dealer.
 *
 * ## The single entry point, on purpose
 *
 * A quote reaches "approved" by two different routes: the auto-rule inside
 * api/inside-sales/lead/[id]/commercials, and the CEO's decision in
 * api/dashboard/ceo/quotations/[commercialId]/decision. Both call
 * `generateQuotationDraft` and neither knows how a document is made. If the two
 * ever built their own, an auto-approved quote and a CEO-approved one would
 * drift into being different documents, which is exactly the class of bug
 * §4 of docs/quotation-approval-flow.md is about.
 *
 * ## It runs AFTER the approval transaction commits
 *
 * Rendering a PDF means launching a browser. That is slow, it touches the
 * filesystem and the network, and it can fail for reasons that have nothing to
 * do with the decision — none of which may roll back an approval the CEO has
 * already made, or hold a row lock while it happens. So the decision commits
 * first and the document is produced afterwards; a failure is recorded in
 * `quote_pdf_error` and surfaced to the sales manager as "retry", never as
 * silence.
 *
 * This mirrors how both routes already treat touchpoints: written after commit,
 * because a history note must not be able to fail a business action.
 *
 * ## It is idempotent
 *
 * Called twice for the same commercial, it returns the first document rather
 * than minting a second number. A quote number is a thing a dealer quotes back
 * at us over the phone; it must not change under them because somebody clicked
 * approve twice or a retry fired.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import type { CommercialsProductLine } from "@/lib/inside-sales/types";
import { renderPdfFromHtml } from "@/lib/pdf/render-html";
import { uploadFileToStorage } from "@/lib/storage";
import { resolveQuotationConfig } from "./quote-pdf/config-store";
import {
  financialYear,
  quoteNumberForVersion,
  quoteNumberRoot,
} from "./quote-pdf/numbering";
import { renderProformaHtml } from "./quote-pdf/proforma-template";
import { buildQuotationView } from "./quote-pdf/view";
import { resolvePlaceOfSupply } from "./quote-pdf/gst-states";
import { loadLineTaxRefs } from "./quote-pdf/view-store";

export interface QuotationDraft {
  commercial_id: string;
  quote_number: string;
  quote_pdf_url: string;
  generated: boolean;
}

export class QuotationDraftError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Allocate the next number in the series, e.g. "ITQ-2026-0001".
 *
 * THE COUNTER DOES NOT RESET EACH APRIL, deliberately. One monotonic sequence
 * is the only allocation that stays unique without a per-year lock, so
 * ITQ-2027-0132 follows ITQ-2026-0131. The year in the string says when the
 * quote was raised; the digits say which quote it is. A per-FY counter would
 * buy prettier numbers at the cost of a race that issues one number twice.
 */
export async function nextQuoteNumber(
  prefix: string,
  at: Date = new Date(),
): Promise<string> {
  const rows = await db.execute<{ n: string }>(
    sql`SELECT nextval('quotation_number_seq')::text AS n`,
  );
  const n = Number((rows as unknown as Record<string, unknown>[])[0]?.n ?? 0);
  return `${prefix}-${financialYear(at)}-${String(n).padStart(4, "0")}`;
}

/**
 * The number this quote should carry.
 *
 * Every version on a lead shares ONE root, so a dealer holding ITQ-2026-0007
 * recognises ITQ-2026-0007-R3 as the same conversation. The root is minted the
 * first time any version on the lead is numbered; which version that happens to
 * be does not matter, because the suffix comes from the version number rather
 * than from the order numbers were handed out. See quoteNumberForVersion.
 *
 * A lead whose earlier versions were all rejected — and so never numbered,
 * because only approval mints one — starts a fresh root rather than inheriting
 * a suffix from a document nobody ever saw.
 */
async function allocateQuoteNumber(
  dealerLeadId: string,
  versionNo: number,
  prefix: string,
  at: Date,
): Promise<string> {
  const prior = await db.execute<{ quote_number: string }>(sql`
    SELECT quote_number
      FROM dealer_lead_commercials
     WHERE dealer_lead_id = ${dealerLeadId}
       AND quote_number IS NOT NULL
     ORDER BY version_no ASC
     LIMIT 1
  `);
  const existing = (prior as unknown as Record<string, unknown>[])[0]?.quote_number;
  const root = existing
    ? quoteNumberRoot(String(existing))
    : await nextQuoteNumber(prefix, at);
  return quoteNumberForVersion(root, versionNo);
}

interface CommercialRow {
  commercial_id: string;
  dealer_lead_id: string;
  version_no: number;
  approval_status: string | null;
  product_lines: unknown;
  quote_number: string | null;
  quote_pdf_url: string | null;
  payment_method: string | null;
  credit_terms: string | null;
  delivery_terms: string | null;
  warranty_terms: string | null;
  deal_notes: string | null;
  dealer_name: string | null;
  dealer_gstin: string | null;
  dealer_state: string | null;
  dealer_city: string | null;
}

export interface GenerateOptions {
  /** Re-render even when a document already exists, keeping the same number. */
  force?: boolean;
  /** Overridable for tests; defaults to now. */
  at?: Date;
}

/**
 * Produce (or return) the quotation document for one approved commercial row.
 *
 * Throws QuotationDraftError for the two states a caller can act on — the row
 * is gone, or it is not approved — and lets anything else propagate so the
 * caller records it in quote_pdf_error.
 */
export async function generateQuotationDraft(
  commercialId: string,
  options: GenerateOptions = {},
): Promise<QuotationDraft> {
  const at = options.at ?? new Date();

  const rows = await db.execute<CommercialRow>(sql`
    SELECT c.commercial_id::text  AS commercial_id,
           c.dealer_lead_id,
           c.version_no,
           c.approval_status,
           c.product_lines,
           c.quote_number,
           c.quote_pdf_url,
           -- The terms the rep agreed. They print on the document and land in
           -- quote_snapshot with it, so a quote re-opened after the row changes
           -- still shows the terms it was sent with.
           c.payment_method,
           c.credit_terms,
           c.delivery_terms,
           c.warranty_terms,
           c.deal_notes,
           l.dealer_name,
           l.gstin  AS dealer_gstin,
           l.state  AS dealer_state,
           l.city   AS dealer_city
      FROM dealer_lead_commercials c
      LEFT JOIN dealer_leads l ON l.id = c.dealer_lead_id
     WHERE c.commercial_id = ${commercialId}
     LIMIT 1
  `);
  const row = (rows as unknown as CommercialRow[])[0];

  if (!row) {
    throw new QuotationDraftError("NOT_FOUND", "Quotation not found.");
  }
  // The gate, restated at the point of production. §4: a document that could be
  // sent to a dealer must not exist for a quote that has not passed approval.
  if (row.approval_status !== "approved") {
    throw new QuotationDraftError(
      "NOT_APPROVED",
      `Cannot draft a quotation that is ${row.approval_status ?? "undecided"}.`,
    );
  }

  if (row.quote_pdf_url && row.quote_number && !options.force) {
    return {
      commercial_id: row.commercial_id,
      quote_number: row.quote_number,
      quote_pdf_url: row.quote_pdf_url,
      generated: false,
    };
  }

  const lines: CommercialsProductLine[] = Array.isArray(row.product_lines)
    ? (row.product_lines as CommercialsProductLine[])
    : [];

  const config = await resolveQuotationConfig();

  // Keep the existing number on a forced re-render: the document changes, the
  // identity the dealer holds does not.
  const quoteNumber =
    row.quote_number ??
    (await allocateQuoteNumber(
      row.dealer_lead_id,
      row.version_no,
      config.numberPrefix,
      at,
    ));

  const taxRefs = await loadLineTaxRefs(lines);
  // Pure since the GST codes moved into ./quote-pdf/gst-states — no lookup, and
  // the dealer's own GSTIN takes precedence over the lead's free-text state.
  const placeOfSupply = resolvePlaceOfSupply(row.dealer_state, row.dealer_gstin);

  const view = buildQuotationView({
    quoteNumber,
    quoteDate: at,
    config,
    lines,
    taxRefs,
    placeOfSupply,
    dealer: {
      name: row.dealer_name,
      gstin: row.dealer_gstin,
      addressLines: row.dealer_city ? [row.dealer_city] : [],
    },
    commercialTerms: {
      paymentMethod: row.payment_method,
      creditTerms: row.credit_terms,
      deliveryTerms: row.delivery_terms,
      warranty: row.warranty_terms,
      dealNotes: row.deal_notes,
    },
  });

  const pdf = await renderPdfFromHtml(renderProformaHtml(view));

  const { url } = await uploadFileToStorage({
    fileBuffer: pdf,
    // The number is unique, so the key is stable and a forced re-render
    // overwrites rather than littering the bucket with orphans.
    fileName: `${quoteNumber}.pdf`,
    folder: "quotations",
    contentType: "application/pdf",
  });

  // ISO string, never a Date: drizzle runs a raw sql`` template through
  // postgres.js unsafe(), which serialises with no column-type information and
  // throws ERR_INVALID_ARG_TYPE on a Date. This is the trap that once broke
  // both buttons on the CEO decision route.
  const nowIso = at.toISOString();

  await db.execute(sql`
    UPDATE dealer_lead_commercials
       SET quote_number           = ${quoteNumber},
           quote_pdf_url          = ${url},
           quote_pdf_generated_at = ${nowIso},
           quote_pdf_error        = NULL,
           quote_snapshot         = ${JSON.stringify(view)}::jsonb,
           updated_at             = NOW()
     WHERE commercial_id = ${commercialId}
  `);

  return {
    commercial_id: row.commercial_id,
    quote_number: quoteNumber,
    quote_pdf_url: url,
    generated: true,
  };
}

/**
 * Generate, and never throw.
 *
 * This is what the two approval routes call. A document that cannot be produced
 * must leave a decision intact and a trace behind, so the failure is written to
 * quote_pdf_error and returned as null rather than raised into a route that has
 * already committed and answered.
 */
export async function tryGenerateQuotationDraft(
  commercialId: string,
  options: GenerateOptions = {},
): Promise<QuotationDraft | null> {
  try {
    return await generateQuotationDraft(commercialId, options);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[quoteDraft] generation failed", {
      commercialId,
      message,
      // errorMessage() drops `cause`, and for a DrizzleQueryError that is where
      // the real error lives. Log the chain.
      cause: e instanceof Error && e.cause instanceof Error ? e.cause.message : undefined,
    });
    try {
      await db.execute(sql`
        UPDATE dealer_lead_commercials
           SET quote_pdf_error = ${message.slice(0, 2000)}, updated_at = NOW()
         WHERE commercial_id = ${commercialId}
      `);
    } catch (inner) {
      console.error("[quoteDraft] could not record the failure either", inner);
    }
    return null;
  }
}
