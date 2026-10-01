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
 * Answer an old version (ID 60): a replaced or withdrawn quote is refused and
 * the dealer is pointed to the latest.
 *
 * Close the deal. Since 29 Sep 2026 (ID 75, handover P2-4) a dealer's APPROVAL
 * moves the lead to Commercials finalised — quote events are the only thing
 * that move commercials stages — and the owner is prompted to Mark Won. Won and
 * Converted stay human actions.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { notifyQuotationDealerDecision } from "@/lib/notifications/events";
import { writeTouchpoint } from "@/lib/touchpoints/write";
import { advanceLeadOnQuoteEvent } from "@/lib/leads/quoteStatus";

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
  | { outcome: "not_sendable"; reason: string }
  | {
      /** ID 60: a later version replaced this one; the dealer answers only the latest. */
      outcome: "replaced";
      latestCommercialId: string | null;
      latestVersionNo: number | null;
      latestQuoteNumber: string | null;
    };

type QuoteRow = {
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
  withdrawn_at: string | null;
  /** The lead's newest quote version (quote_issue / quote_revision), which may be this row. */
  latest_commercial_id: string | null;
  latest_version_no: number | null;
  latest_quote_number: string | null;
}

/**
 * Why a dealer may not answer this version (ID 60), or null when they may:
 * withdrawn, or replaced by a later quote version.
 */
export function staleQuoteReason(
  row: Pick<QuoteRow, "commercial_id" | "withdrawn_at" | "latest_commercial_id">,
): "withdrawn" | "replaced" | null {
  if (row.withdrawn_at) return "withdrawn";
  if (row.latest_commercial_id && row.latest_commercial_id !== row.commercial_id) return "replaced";
  return null;
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
           c.withdrawn_at::text AS withdrawn_at,
           l.dealer_name, l.current_owner_id,
           latest.commercial_id::text AS latest_commercial_id,
           latest.version_no AS latest_version_no,
           latest.quote_number AS latest_quote_number
      FROM dealer_lead_commercials c
      LEFT JOIN dealer_leads l ON l.id = c.dealer_lead_id
      -- ID 60: the newest QUOTE version of this lead. Terms / final-terms rows
      -- are versions too but not quotes, so they never "replace" a quote.
      LEFT JOIN LATERAL (
        SELECT q.commercial_id, q.version_no, q.quote_number
          FROM dealer_lead_commercials q
         WHERE q.dealer_lead_id = c.dealer_lead_id
           AND q.event_type IN ('quote_issue', 'quote_revision')
         ORDER BY q.version_no DESC
         LIMIT 1
      ) latest ON TRUE
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
  // ID 60: only the current, not-withdrawn version can be answered — a yes on
  // an old link must never record a deal at a superseded price.
  const stale = staleQuoteReason(row);
  if (stale === "withdrawn") {
    return { outcome: "not_sendable", reason: "This quotation has been withdrawn." };
  }
  if (stale === "replaced") {
    return {
      outcome: "replaced",
      latestCommercialId: row.latest_commercial_id,
      latestVersionNo: row.latest_version_no,
      latestQuoteNumber: row.latest_quote_number,
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
       AND withdrawn_at IS NULL
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
      // ID 75.5: the dealer acted, not the owner — never the owner's work.
      countsAsWork: false,
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

  // ID 75: the dealer's yes finalises the commercials (never fails the answer).
  // ID 75.5: the move is the system's (actor null), not the owner's work —
  // advanceLeadOnQuoteEvent never stamps last_worked_at.
  let awaitingVisit = false;
  if (input.decision === "approved") {
    const advanced = await advanceLeadOnQuoteEvent(row.dealer_lead_id, "dealer_approved", null);
    awaitingVisit = advanced.awaitingVisit === true;

    // ID 74.1: an approved quote clears the "Won without an approved quote"
    // flag on a lead that was marked Won (or already Converted) before it.
    try {
      await db.execute(sql`
        UPDATE dealer_leads
           SET won_without_approved_quote = false
         WHERE id = ${row.dealer_lead_id}
           AND lead_status IN ('Won', 'Converted')
           AND won_without_approved_quote IS TRUE
      `);
    } catch (e) {
      console.error("[quoteDecision] won_without_approved_quote not cleared", e);
    }
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
    awaitingVisit,
  });

  return {
    outcome: "recorded",
    quoteNumber: row.quote_number,
    decision: input.decision,
  };
}
