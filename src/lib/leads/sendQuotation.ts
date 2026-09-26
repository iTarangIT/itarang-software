/**
 * E-242 — send an approved quotation to the dealer. The one writer behind
 * POST /api/inside-sales/lead/:id/commercials/:commercialId/send AND the
 * WhatsApp Assistant's send_quote.
 *
 * The guard IS the state machine (docs/quotation-approval-flow.md §4): anything
 * whose `approval_status` is not 'approved', or that has no generated document,
 * is refused with QuotationNotSendableError. A pending quote has no
 * `quote_pdf_url` because generateQuotationDraft refuses to produce one, so the
 * two checks agree by construction.
 *
 * Role and ownership rules stay with the callers: the route lets a sales
 * manager send a quote they do not own; the Assistant only its owner's.
 *
 * The read + gate live in quoteSendGate.ts (db only), so a preview can check
 * them without loading the PDF / storage / provider stack this file pulls in.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { writeTouchpoint } from "@/lib/touchpoints/write";
import {
  dispatchQuotation,
  type DispatchOutcome,
  type QuoteDispatchChannel,
} from "@/lib/leads/quoteDispatch";
import { resolveQuotationCc } from "@/lib/leads/quotationCc";
import { assertSendable, loadQuote } from "@/lib/leads/quoteSendGate";

export {
  assertSendable,
  loadQuote,
  QuotationNotSendableError,
  type QuoteRow,
} from "@/lib/leads/quoteSendGate";

export interface SendApprovedQuotationInput {
  leadId: string;
  commercialId: string;
  channels: QuoteDispatchChannel[];
  /** Override recipients; null/undefined = the lead's own. */
  email?: string | null;
  phone?: string | null;
  message?: string | null;
  extraCc?: string[];
  actor: { id: string; name: string | null };
}

export interface SendApprovedQuotationResult {
  quote_number: string;
  outcomes: DispatchOutcome[];
  sent_count: number;
  failed_count: number;
}

export async function sendApprovedQuotation(
  input: SendApprovedQuotationInput,
): Promise<SendApprovedQuotationResult> {
  const { leadId: id, commercialId, actor } = input;
  const row = await loadQuote(id, commercialId);
  assertSendable(row);

  const email = input.email ?? row.dealer_email;
  const phone = input.phone ?? row.dealer_phone;

  // E-297 — resolved server-side, never trusted from the client: owner, the
  // sender (B4) and the admin fixed list, plus any validated extras. Resolved
  // for every send: CC'd on the email, or — WhatsApp having no CC — sent a
  // separate internal notice on a WhatsApp-only send.
  const cc = (
    await resolveQuotationCc(id, commercialId, {
      dealerEmail: email,
      extra: input.extraCc ?? [],
      actorId: actor.id,
    })
  ).cc;
  const quoteTotal = row.quote_total == null ? null : Number(row.quote_total);

  const outcomes = await dispatchQuotation({
    commercialId,
    dealerLeadId: row.dealer_lead_id,
    // E-243 — signed into the approval token, so a link can only ever open
    // the exact document version the dealer was sent.
    versionNo: row.version_no,
    quoteNumber: row.quote_number,
    pdfUrl: row.quote_pdf_url,
    dealerName: row.dealer_name,
    channels: input.channels,
    email,
    phone,
    message: input.message,
    cc,
    quoteTotal: Number.isFinite(quoteTotal) ? quoteTotal : null,
    senderName: actor.name,
    sentBy: actor.id,
  });

  const sent = outcomes.filter((o) => o.status === "sent");
  const failed = outcomes.filter((o) => o.status === "failed");
  const notice = outcomes.find((o) => o.ccNotice);

  // Remember a corrected address so the next revision does not need it typed
  // again — but only when the email actually went, so a typo that bounced at
  // the provider is not saved over a working address.
  if (
    input.email &&
    input.email !== row.dealer_email &&
    sent.some((o) => o.channel === "email")
  ) {
    try {
      await db.execute(sql`
        UPDATE dealer_leads
           SET contact_email = ${input.email}, updated_at = NOW()
         WHERE id = ${row.dealer_lead_id}
      `);
    } catch (e) {
      console.error("[commercials/send] could not save dealer email", e);
    }
  }

  // One touchpoint for the send, and only when something actually went. A
  // history entry for a send where every channel failed would put a delivery
  // that never happened into the lead timeline — the same mistake E-221
  // avoided by not writing `quote_sent` on submission.
  if (sent.length) {
    await writeTouchpoint({
      dealerLeadId: row.dealer_lead_id,
      touchpointType: "quote_dispatched",
      performedBy: actor.id,
      remarks:
        `Quotation ${row.quote_number} sent to dealer via ` +
        sent.map((o) => `${o.channel} (${o.recipient})`).join(", ") +
        (failed.length
          ? ` — failed on ${failed.map((o) => o.channel).join(", ")}`
          : "") +
        (notice?.ccNotice === "sent"
          ? ` — internal team notified by email (${notice.cc?.length ?? 0})`
          : notice?.ccNotice === "failed"
            ? " — internal team notice email failed"
            : ""),
      attachments: [{ url: row.quote_pdf_url, type: "quote" }],
    });
  }

  return {
    quote_number: row.quote_number,
    outcomes,
    sent_count: sent.length,
    failed_count: failed.length,
  };
}
