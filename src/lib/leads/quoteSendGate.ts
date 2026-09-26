// E-242 — the read and the gate for sending a quotation, with no dependency
// beyond the database: shared by sendApprovedQuotation (sendQuotation.ts) and
// the WhatsApp Assistant's send_quote preview, which must not load the
// PDF / storage / provider stack just to build a card.
//
// The guard IS the state machine (docs/quotation-approval-flow.md §4): not
// 'approved', or no generated document, and it cannot go to a dealer.
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

export type QuoteRow = {
  commercial_id: string;
  dealer_lead_id: string;
  approval_status: string | null;
  quote_number: string | null;
  quote_pdf_url: string | null;
  quote_pdf_error: string | null;
  version_no: number;
  dealer_name: string | null;
  dealer_phone: string | null;
  dealer_email: string | null;
  /** Grand total of the rendered quotation (snapshot), else the row's price. */
  quote_total: string | null;
  // E-243 — what the dealer said back, if anything yet.
  dealer_decision: string | null;
  dealer_decision_at: string | null;
  dealer_decision_via: string | null;
  dealer_decision_note: string | null;
};

export async function loadQuote(
  leadId: string,
  commercialId: string,
): Promise<QuoteRow | null> {
  const rows = await db.execute<QuoteRow>(sql`
    SELECT c.commercial_id::text AS commercial_id,
           c.dealer_lead_id, c.approval_status, c.quote_number,
           c.quote_pdf_url, c.quote_pdf_error, c.version_no,
           c.dealer_decision, c.dealer_decision_at, c.dealer_decision_via,
           c.dealer_decision_note,
           COALESCE((c.quote_snapshot->>'total')::numeric,
                    c.final_price, c.price_quoted)::text AS quote_total,
           l.dealer_name, l.phone AS dealer_phone, l.contact_email AS dealer_email
      FROM dealer_lead_commercials c
      LEFT JOIN dealer_leads l ON l.id = c.dealer_lead_id
     WHERE c.commercial_id = ${commercialId}::uuid
       -- Scoped to the lead in the path: a commercial id from another lead must
       -- not be sendable by pairing it with a lead the caller can see.
       AND c.dealer_lead_id = ${leadId}
     LIMIT 1
  `);
  return (rows as unknown as QuoteRow[])[0] ?? null;
}

/** Why a quotation cannot go to the dealer. The route maps it to 404 / 409. */
export class QuotationNotSendableError extends Error {
  constructor(
    readonly reason: "not_found" | "not_approved" | "no_draft",
    message: string,
  ) {
    super(message);
    this.name = "QuotationNotSendableError";
  }
}

/** Throw unless this quotation may be sent. Pure — shared with previews. */
export function assertSendable(row: QuoteRow | null): asserts row is QuoteRow & {
  quote_pdf_url: string;
  quote_number: string;
} {
  if (!row) throw new QuotationNotSendableError("not_found", "Quotation not found.");
  if (row.approval_status !== "approved") {
    throw new QuotationNotSendableError(
      "not_approved",
      `This quotation is ${row.approval_status ?? "undecided"} and cannot be sent to a dealer.`,
    );
  }
  if (!row.quote_pdf_url || !row.quote_number) {
    throw new QuotationNotSendableError(
      "no_draft",
      "The quotation draft has not been generated yet. Regenerate it before sending.",
    );
  }
}
