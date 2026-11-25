/**
 * Direct mid-negotiation acceptance of the standing counter (dealer leg).
 *
 * ONE implementation, TWO callers — the admin accepting the dealer's last
 * counter, and the dealer accepting iTarang's last counter — because the move is
 * symmetric: whoever accepts is agreeing to the OTHER side's most recent price.
 * This is the "Accept" button on the negotiation card, the mirror of the vendor
 * leg's `vendor_agree`.
 *
 * WHY IT WRITES A FINAL OFFER. The accepted dealer price is not stored on the
 * negotiation round; linesForRequest reads it from the `final_offer_lines` of
 * the ACCEPTED final_offer at the current version (queries.ts), and the margin
 * route locks from that. So "accept the counter" snapshots the standing
 * counter's per-SKU prices into an ACCEPTED final_offer and moves the deal to
 * DEALER_ACCEPTED — after which set_margin, the floor, and the whole vendor leg
 * read exactly what they would after a formal final-offer acceptance. The
 * final-offer ceremony (send_final_offer → dealer_accept) is untouched; this is
 * the shortcut, not a replacement.
 *
 * The delete-then-insert of non-ACCEPTED offers at this version is the same
 * guard send_final_offer uses (final-offer/route.ts): a prior DECLINED offer at
 * this version would otherwise collide with final_offers_deal_version_unique.
 */

import { and, eq, ne, sql } from "drizzle-orm";

import { finalOfferLines, finalOffers } from "@/lib/db/schema";

import { TransitionError, ValidationError } from "./errors";
import { buildAskPrices } from "./floor";
import { linesForRequest } from "./queries";
import { transition } from "./state-machine";
import type { DealAction, DealState } from "./state-machine";
import { applyTransition } from "./transition";
import type { BuybackTx } from "./tx";

interface AcceptStandingInput {
  tx: BuybackTx;
  dealId: string;
  requestId: string;
  requestNo: string;
  offerVersion: number;
  /** Who is accepting — decides whose counter must be standing, and the action. */
  acceptedBy: "admin" | "dealer";
  actor: { id: string; role: "admin" | "dealer"; crmRole?: string };
}

interface RoundRow {
  id: string;
  round_no: number;
  offered_by_role: string;
  lines: Array<{ line_id: string; price: string }> | null;
}

export async function acceptStandingCounter({
  tx,
  dealId,
  requestId,
  requestNo,
  offerVersion,
  acceptedBy,
  actor,
}: AcceptStandingInput): Promise<{ status: string; final_offer_id: string; total: number }> {
  // You accept the OTHER side's offer, so the standing round must be theirs.
  const counterpartRole = acceptedBy === "admin" ? "dealer" : "admin";

  const rows = await tx.execute(sql`
    SELECT nr.id, nr.round_no, nr.offered_by_role,
      json_agg(
        json_build_object('line_id', nrl.line_id, 'price', nrl.offered_price_per_unit)
        ORDER BY nrl.line_id
      ) FILTER (WHERE nrl.id IS NOT NULL) AS lines
    FROM negotiation_rounds nr
    LEFT JOIN negotiation_round_lines nrl ON nrl.round_id = nr.id
    WHERE nr.deal_id = ${dealId} AND nr.leg = 'DEALER'
    GROUP BY nr.id
    ORDER BY nr.round_no DESC
    LIMIT 1
  `);
  const latest = (rows as unknown as RoundRow[])[0];

  if (!latest) {
    throw new ValidationError("There is no offer on the table to accept yet.");
  }
  if (latest.offered_by_role !== counterpartRole) {
    // The latest round is your OWN offer — it is the other side's turn, so there
    // is nothing for you to accept yet.
    throw new ValidationError(
      acceptedBy === "admin"
        ? "The latest offer on the table is iTarang's. Wait for the dealer to respond before accepting."
        : "The latest offer on the table is yours. Wait for iTarang to respond before accepting.",
    );
  }

  const priced = latest.lines ?? [];
  if (priced.length === 0) {
    throw new ValidationError("The standing offer has no priced lines to accept.");
  }

  // Every line on the request must be covered — the same completeness rule the
  // final-offer route enforces, so DEALER_ACCEPTED never leaves a line unpriced
  // (set_margin refuses an unpriced line).
  const allLines = await linesForRequest(requestId, tx);
  const covered = new Set(priced.map((l) => l.line_id));
  const missing = allLines.filter((l) => !covered.has(l.id));
  if (missing.length > 0) {
    throw new ValidationError(
      `The standing offer prices ${priced.length} line(s), but the request has ${allLines.length}. Every line must be priced before it can be accepted.`,
    );
  }

  // Clear any non-ACCEPTED offer at this version, then snapshot the accepted
  // prices as the ACCEPTED final_offer that linesForRequest / set_margin read.
  await tx
    .delete(finalOffers)
    .where(
      and(
        eq(finalOffers.deal_id, dealId),
        eq(finalOffers.version_no, offerVersion),
        ne(finalOffers.status, "ACCEPTED"),
      ),
    );

  const [offer] = await tx
    .insert(finalOffers)
    .values({
      deal_id: dealId,
      version_no: offerVersion,
      status: "ACCEPTED",
      note: `Accepted the standing counter (round ${latest.round_no}) directly.`,
      sent_by: actor.id,
      responded_at: new Date(),
    })
    .returning({ id: finalOffers.id });

  await tx.insert(finalOfferLines).values(
    priced.map((l) => ({
      final_offer_id: offer.id,
      line_id: l.line_id,
      price_per_unit: String(l.price),
    })),
  );

  const total = priced.reduce((sum, l) => {
    const line = allLines.find((x) => x.id === l.line_id);
    return sum + (line ? line.quantity * Number(l.price) : 0);
  }, 0);

  const action: DealAction =
    acceptedBy === "admin" ? "admin_accept_counter" : "dealer_accept_counter";

  const result = await applyTransition({
    tx,
    dealId,
    requestId,
    currentStatus: "NEGOTIATING",
    offerVersion,
    action,
    actor,
    after: { final_offer_id: offer.id, accepted_round: latest.round_no, total },
    notificationPayload: { request_no: requestNo, total },
  });

  return { status: result.to, final_offer_id: offer.id, total };
}

/**
 * The review-bar Accept (SUBMITTED / UNDER_REVIEW → DEALER_ACCEPTED): iTarang
 * agrees to the dealer's OWN asking price on every line, with no haggle.
 *
 * Before this existed the `accept` action only flipped the status. No ACCEPTED
 * final offer was written, so linesForRequest returned dealer_price = NULL, the
 * Margin & Routing tab showed the whole order at ₹0, and set_margin refused to
 * lock. Every OTHER road into DEALER_ACCEPTED (final offer → dealer_accept, and
 * acceptStandingCounter above) snapshots an ACCEPTED final offer; this makes
 * the review-bar accept do the same, so all three leave the deal in one shape.
 *
 * A line with no usable asking price is refused before anything is written —
 * the admin must Negotiate (which prices every line) instead.
 */
export async function acceptDealerAsk({
  tx,
  dealId,
  requestId,
  requestNo,
  offerVersion,
  currentStatus,
  actor,
}: {
  tx: BuybackTx;
  dealId: string;
  requestId: string;
  requestNo: string;
  offerVersion: number;
  currentStatus: DealState;
  actor: { id: string; role: "admin" };
}): Promise<{ from: DealState; to: DealState; final_offer_id: string; total: number }> {
  // State gate first, so a wrong-state click gets the state machine's reason,
  // not a price complaint. applyTransition re-checks it under the status guard.
  const gate = transition(currentStatus, "accept", "admin");
  if (!gate.ok) throw new TransitionError(gate.reason);

  const allLines = await linesForRequest(requestId, tx);
  const ask = buildAskPrices(allLines);
  if (!ask.ok) {
    throw new ValidationError(
      ask.reason === "empty"
        ? "This request has no battery lines to accept."
        : ask.reason === "missing"
          ? `${ask.variant_type} has no asking price from the dealer. Use Negotiate to price every line before accepting.`
          : `The dealer's asking price for ${ask.variant_type} is not usable (${ask.raw}). Use Negotiate to price every line before accepting.`,
    );
  }

  await tx
    .delete(finalOffers)
    .where(
      and(
        eq(finalOffers.deal_id, dealId),
        eq(finalOffers.version_no, offerVersion),
        ne(finalOffers.status, "ACCEPTED"),
      ),
    );

  const [offer] = await tx
    .insert(finalOffers)
    .values({
      deal_id: dealId,
      version_no: offerVersion,
      status: "ACCEPTED",
      note: "Accepted the dealer's asking price at review.",
      sent_by: actor.id,
      responded_at: new Date(),
    })
    .returning({ id: finalOffers.id });

  await tx.insert(finalOfferLines).values(
    ask.prices.map((p) => ({
      final_offer_id: offer.id,
      line_id: p.line_id,
      price_per_unit: String(p.price_per_unit),
    })),
  );

  const result = await applyTransition({
    tx,
    dealId,
    requestId,
    currentStatus,
    offerVersion,
    action: "accept",
    actor,
    after: { final_offer_id: offer.id, total: ask.total, lines: ask.prices },
    notificationPayload: { request_no: requestNo, total: ask.total },
  });

  return { from: result.from, to: result.to, final_offer_id: offer.id, total: ask.total };
}
