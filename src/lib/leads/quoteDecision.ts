/**
 * E-243 — recording what the dealer said about a quotation.
 *
 * THE SINGLE WRITER. Two surfaces can produce a dealer decision — the signed
 * approval page and a tapped WhatsApp button — and both go through
 * `recordDealerDecision`. Neither knows how the decision is stored, who gets
 * told, or what makes it idempotent, which is what stops the two paths drifting
 * into recording subtly different things. Same reasoning as
 * generateQuotationDraft being the only producer of a draft.
 *
 * ## First answer wins, and it is enforced in SQL
 *
 * The UPDATE carries `WHERE dealer_decision IS NULL`. A forwarded email, a
 * double-tap, a link opened twice on two devices — all of them find zero rows
 * updated and are reported as "already answered" rather than overwriting a
 * decision or notifying the owner twice. This is also what makes the approval
 * token safe to be stateless: single use is a property of the answer, not of
 * the link.
 *
 * ## What it deliberately does NOT do
 *
 * Move the lead. A dealer is an outside party; letting one drive the internal
 * state machine would mean a mis-tap silently rewrites pipeline reporting. The
 * decision is recorded, a touchpoint is written and the owner is notified — a
 * human still advances the lead. The conversion flow is untouched.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { notifyQuotationDealerDecision } from "@/lib/notifications/events";
import { writeTouchpoint } from "@/lib/touchpoints/write";

// The vocabulary lives in ./quoteDecision.types so pure consumers (the button
// parser, route zod schemas) can name it without importing a DB connection.
// Re-exported here so a caller that wants both needs only this module.
export {
  DEALER_DECISIONS,
  DEALER_DECISION_CHANNELS,
  type DealerDecision,
  type DealerDecisionChannel,
} from "./quoteDecision.types";

import type {
  DealerDecision,
  DealerDecisionChannel,
} from "./quoteDecision.types";

export interface RecordDealerDecisionInput {
  commercialId: string;
  decision: DealerDecision;
  via: DealerDecisionChannel;
  /** The dealer's WhatsApp number, or "token" for a signed-link click. */
  actor: string;
  /** Anything the dealer typed alongside it. Usually null — a button carries none. */
  note?: string | null;
}

export type RecordDealerDecisionResult =
  | { outcome: "recorded"; quoteNumber: string | null; decision: DealerDecision }
  | {
      outcome: "already_answered";
      quoteNumber: string | null;
      decision: DealerDecision;
      decidedAt: string | null;
    }
  | { outcome: "not_found" }
  | { outcome: "not_sendable"; reason: string };

interface QuoteRow {
  commercial_id: string;
  dealer_lead_id: string;
  version_no: number;
  approval_status: string | null;
  quote_number: string | null;
  quote_pdf_url: string | null;
  dealer_decision: string | null;
  dealer_decision_at: string | null;
  dealer_name: string | null;
  current_owner_id: string | null;
  final_price: string | null;
  price_quoted: string | null;
}

/** The quotation behind a token or a WhatsApp reply, with what the page needs to render. */
export async function loadQuotationForDealer(
  commercialId: string,
): Promise<QuoteRow | null> {
  const rows = await db.execute<QuoteRow>(sql`
    SELECT c.commercial_id::text AS commercial_id,
           c.dealer_lead_id, c.version_no, c.approval_status,
           c.quote_number, c.quote_pdf_url,
           c.dealer_decision, c.dealer_decision_at,
           c.final_price::text AS final_price,
           c.price_quoted::text AS price_quoted,
           l.dealer_name, l.current_owner_id
      FROM dealer_lead_commercials c
      LEFT JOIN dealer_leads l ON l.id = c.dealer_lead_id
     WHERE c.commercial_id = ${commercialId}::uuid
     LIMIT 1
  `);
  return (rows as unknown as QuoteRow[])[0] ?? null;
}

/**
 * Record the dealer's answer, once.
 *
 * Never throws for a business reason — every refusal is a typed outcome the
 * caller renders. Only an infrastructure failure propagates.
 */
export async function recordDealerDecision(
  input: RecordDealerDecisionInput,
): Promise<RecordDealerDecisionResult> {
  const row = await loadQuotationForDealer(input.commercialId);
  if (!row) return { outcome: "not_found" };

  // The same gate the send route applies, restated where the answer lands: a
  // dealer can only answer a quotation that was actually approved and drafted.
  // Without this, a token minted before a later rejection would still accept an
  // approval for a quote iTarang has withdrawn.
  if (row.approval_status !== "approved") {
    return {
      outcome: "not_sendable",
      reason: `This quotation is ${row.approval_status ?? "undecided"} and is no longer open for a response.`,
    };
  }
  if (!row.quote_pdf_url) {
    return {
      outcome: "not_sendable",
      reason: "This quotation has no document to respond to.",
    };
  }

  // Fast path for a link opened twice — saves the UPDATE, though the WHERE
  // clause below is what actually guarantees it.
  if (row.dealer_decision) {
    return {
      outcome: "already_answered",
      quoteNumber: row.quote_number,
      decision: row.dealer_decision as DealerDecision,
      decidedAt: row.dealer_decision_at,
    };
  }

  // ISO string, never a Date — a raw sql`` template is serialised by
  // postgres.js unsafe() with no column type and throws on a Date object.
  const nowIso = new Date().toISOString();

  // WHERE dealer_decision IS NULL is the whole idempotency guarantee. Two
  // concurrent taps race here and exactly one updates a row.
  const updated = await db.execute<{ commercial_id: string }>(sql`
    UPDATE dealer_lead_commercials
       SET dealer_decision       = ${input.decision},
           dealer_decision_at    = ${nowIso},
           dealer_decision_via   = ${input.via},
           dealer_decision_actor = ${input.actor},
           dealer_decision_note  = ${input.note ?? null},
           updated_at            = NOW()
     WHERE commercial_id = ${input.commercialId}::uuid
       AND dealer_decision IS NULL
    RETURNING commercial_id::text AS commercial_id
  `);

  if ((updated as unknown as unknown[]).length === 0) {
    // Lost the race. Re-read so the caller reports what actually stands.
    const fresh = await loadQuotationForDealer(input.commercialId);
    return {
      outcome: "already_answered",
      quoteNumber: row.quote_number,
      decision: (fresh?.dealer_decision as DealerDecision) ?? input.decision,
      decidedAt: fresh?.dealer_decision_at ?? null,
    };
  }

  const value = Number(row.final_price ?? row.price_quoted ?? 0);
  const label = input.decision === "approved" ? "approved" : "declined";
  const channel = input.via === "whatsapp" ? "over WhatsApp" : "via the approval link";
  const ref = row.quote_number ? ` ${row.quote_number}` : "";

  // After the write, and never allowed to undo it: a history note or a
  // notification that fails must not lose an answer the dealer has given.
  try {
    await writeTouchpoint({
      dealerLeadId: row.dealer_lead_id,
      touchpointType:
        input.decision === "approved" ? "quote_dealer_approved" : "quote_dealer_declined",
      // The dealer is not a user, so there is no id to attribute this to.
      // `performedBy` carries the owner — the person on our side the entry
      // belongs to — and the remark says plainly who actually acted.
      performedBy: row.current_owner_id ?? "system",
      remarks:
        `Dealer ${label} quotation${ref} ${channel}` +
        (value > 0 ? ` — ₹${value.toLocaleString("en-IN")}` : "") +
        (input.note ? ` · "${input.note}"` : ""),
      attachments: row.quote_pdf_url
        ? [{ url: row.quote_pdf_url, type: "quote" }]
        : [],
    });
  } catch (e) {
    console.error("[quoteDecision] touchpoint failed", e);
  }

  await notifyQuotationDealerDecision({
    leadId: row.dealer_lead_id,
    commercialId: row.commercial_id,
    ownerUserId: row.current_owner_id,
    dealerName: row.dealer_name,
    quoteNumber: row.quote_number,
    value,
    decision: input.decision,
    via: input.via,
    note: input.note ?? null,
  });

  return {
    outcome: "recorded",
    quoteNumber: row.quote_number,
    decision: input.decision,
  };
}
