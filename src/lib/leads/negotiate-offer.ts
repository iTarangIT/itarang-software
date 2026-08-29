/**
 * "Ask this lender for better terms" — the write, lifted out of the dealer route.
 *
 * WHY THIS EXISTS.
 *
 * `POST /api/lead/[id]/negotiate-offer` was the only way to counter an offer,
 * and every line below its auth check is channel-agnostic. The customer can now
 * raise the same ask from inside their WhatsApp chat, where there is no Supabase
 * session to hand `requireRole("dealer")`. Same split as `submit-step4.ts`: the
 * caller answers *who is asking and may they*, this answers *what gets written*.
 *
 * WHY THE GUARDS LIVE HERE AND NOT IN THE ROUTE. Fixed terms, a withdrawn
 * assignment, a CEO-held revision and the 20-round cap are not authorisation —
 * they are what the negotiation itself permits, and they must hold identically
 * whoever is asking. A second copy in the orchestrator is how a chat turn ends
 * up appending a 21st round, or countering terms the borrower was never allowed
 * to see.
 *
 * THE CUSTOMER AS AN AUTHOR. `nbfc_offer_negotiations.party` gains a third
 * value, 'customer', beside 'nbfc' and 'dealer'. The column is varchar(8) with
 * no CHECK (E-238 chose route-layer enforcement) and 'customer' is exactly eight
 * characters, so this needs no migration — see E-265 for the COMMENT that
 * records it.
 *
 * `negotiation_status` does NOT gain a matching value. It is varchar(16) and
 * 'customer_countered' is nineteen characters, so it would silently fail to
 * write. It stays 'dealer_countered', which is read as "the borrower side
 * countered" — the status says whose TURN it is, the round's `party` says who
 * actually typed. Every existing reader (`can_act`, the NBFC's Revise button,
 * the thread) keys off the status and needs no change.
 */

import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  nbfc,
  nbfcAuditLog,
  nbfcFinancingOffers,
  nbfcLeadAssignments,
} from "@/lib/db/schema";
import {
  MAX_MESSAGE_LENGTH,
  MAX_NEGOTIATION_ROUNDS,
  NEGOTIABLE_FIELDS,
  appendRound,
  isAssignmentDecided,
  seedOpeningRoundIfMissing,
  type NegotiationParty,
} from "@/lib/nbfc/offer-negotiation";
import { isOfferReleased } from "@/lib/leads/offers";
import { notifyOfferNegotiated } from "@/lib/notifications/events";

/**
 * A refusal the caller should show verbatim. `status` is the HTTP code the route
 * returns; the chat flow ignores it and prints `message`, which is why every
 * message below is written for a borrower to read, not for a log.
 */
export class OfferActionError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "OfferActionError";
    this.status = status;
  }
}

/**
 * Who is raising the ask.
 *
 * `kind` becomes the round's `party` — the authoritative record of who spoke.
 *
 * `userId` becomes `nbfc_offer_negotiations.created_by`, which is nullable: a
 * customer writing from their own WhatsApp chat has no `users` row, and
 * inventing one would be worse than an honest NULL.
 *
 * `auditUserId` is separate and REQUIRED because `nbfc_audit_log.user_id` is
 * `uuid NOT NULL`. For a customer-authored round the caller passes the user
 * accountable for the lead — its dealer's `uploader_id` — so the compliance log
 * still names a real person. Who actually typed is not lost: the audit row's
 * `after_state.party` carries it. Dropping the audit row instead would leave the
 * one path a borrower can move an offer from as the only unaudited one.
 */
export interface NegotiationActor {
  kind: NegotiationParty;
  userId: string | null;
  auditUserId: string;
}

export interface NegotiateOfferResult {
  leadId: string;
  nbfcId: number;
  negotiationStatus: "dealer_countered";
  round: number;
}

/**
 * Append a borrower-side counter to a lender's offer thread.
 *
 * The caller owns authorisation (a dealer session, or a phone number
 * `authorizeLeadAction` has already matched to the lead). Throws
 * `OfferActionError` for anything the borrower should be told about; anything
 * else is a genuine failure and propagates.
 */
export async function negotiateOffer(opts: {
  leadId: string;
  nbfcId: number;
  message: string;
  actor: NegotiationActor;
}): Promise<NegotiateOfferResult> {
  const { leadId, nbfcId, actor } = opts;

  const message = opts.message.trim();
  if (!message) {
    throw new OfferActionError("Write a message to the lender before sending.");
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    throw new OfferActionError(
      `Keep the message under ${MAX_MESSAGE_LENGTH} characters.`,
    );
  }

  const [assignment] = await db
    .select({
      id: nbfcLeadAssignments.id,
      nbfc_id: nbfcLeadAssignments.nbfc_id,
      tenant_id: nbfcLeadAssignments.tenant_id,
      status: nbfcLeadAssignments.status,
    })
    .from(nbfcLeadAssignments)
    .where(
      and(
        eq(nbfcLeadAssignments.lead_id, leadId),
        eq(nbfcLeadAssignments.nbfc_id, nbfcId),
      ),
    )
    .limit(1);
  if (!assignment) {
    throw new OfferActionError("That lender is not among this lead's lenders.");
  }
  if (isAssignmentDecided(assignment.status)) {
    throw new OfferActionError(
      assignment.status === "withdrawn"
        ? "This deal was closed; it can no longer be negotiated."
        : "A lender has already been chosen for this application.",
    );
  }

  const [offer] = await db
    .select()
    .from(nbfcFinancingOffers)
    .where(eq(nbfcFinancingOffers.assignment_id, assignment.id))
    .limit(1);
  if (!offer) {
    throw new OfferActionError("That lender has not made an offer yet.");
  }
  // E-161 — you cannot counter terms you are not allowed to see.
  if (!isOfferReleased(offer)) {
    throw new OfferActionError(
      "These revised terms are still under iTarang review. Try again once they are released.",
    );
  }
  if (offer.negotiation_status === "fixed") {
    throw new OfferActionError(
      "The lender has fixed these terms; they can no longer be negotiated.",
    );
  }
  if (offer.negotiation_round >= MAX_NEGOTIATION_ROUNDS) {
    throw new OfferActionError(
      `This negotiation has reached ${MAX_NEGOTIATION_ROUNDS} rounds. Ask the lender to fix the terms, or choose one.`,
    );
  }

  const now = new Date();
  const before = Object.fromEntries(NEGOTIABLE_FIELDS.map((f) => [f, offer[f]]));
  let round = offer.negotiation_round + 1;

  await db.transaction(async (tx) => {
    // Offers predating E-238 have no round 1 on record; seed it from the
    // current terms so the history starts where the conversation did.
    const base = await seedOpeningRoundIfMissing(tx, offer);
    round = base + 1;

    await appendRound(tx, {
      offer_id: offer.id,
      assignment_id: assignment.id,
      lead_id: leadId,
      nbfc_id: assignment.nbfc_id,
      tenant_id: assignment.tenant_id,
      round,
      party: actor.kind,
      kind: "counter",
      // The borrower moves no numbers (E-245), so the round carries the standing
      // terms verbatim — a round is always a full snapshot and can be read on
      // its own years later. The thread renders it as "no change to the terms"
      // plus the message, which is exactly what happened.
      terms: before,
      message,
      created_by: actor.userId ?? undefined,
      created_at: now,
    });

    // Guarded on the round we read: if another writer moved first, this matches
    // zero rows and the appendRound above has already collided with the UNIQUE
    // index, rolling the whole transaction back.
    await tx
      .update(nbfcFinancingOffers)
      .set({
        negotiation_status: "dealer_countered",
        negotiation_round: round,
        updated_at: now,
      })
      .where(
        and(
          eq(nbfcFinancingOffers.id, offer.id),
          eq(nbfcFinancingOffers.negotiation_round, offer.negotiation_round),
        ),
      );

    // Audit inside the transaction, per every other nbfc_audit_log writer
    // (src/lib/nbfc/recovery/stages.ts is the canonical example).
    await tx.insert(nbfcAuditLog).values({
      tenant_id: assignment.tenant_id,
      user_id: actor.auditUserId,
      action_type: "offer_negotiate",
      action_id: offer.id,
      before_state: {
        lead_id: leadId,
        nbfc_id: assignment.nbfc_id,
        round: base,
        terms: before,
      },
      after_state: {
        lead_id: leadId,
        nbfc_id: assignment.nbfc_id,
        round,
        terms: before,
        message,
        party: actor.kind,
      },
      created_at: now,
    });
  });

  // Best-effort, outside the transaction — matches how select-winner handles its
  // notification side effects.
  try {
    const [row] = await db
      .select({ legal_name: nbfc.legal_name, short_name: nbfc.short_name })
      .from(nbfc)
      .where(eq(nbfc.id, nbfcId))
      .limit(1);
    await notifyOfferNegotiated({
      leadId,
      nbfcTenantId: assignment.tenant_id,
      nbfcName: row?.short_name || row?.legal_name || "the lender",
      message,
    });
  } catch (err) {
    console.error("[negotiate-offer] notification failed:", err);
  }

  return { leadId, nbfcId, negotiationStatus: "dealer_countered", round };
}
