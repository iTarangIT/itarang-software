/**
 * Side-effects of an iTarang CEO decision on an out-of-band financing offer —
 * BRD Addendum V0.3.1 §13.3.4. Invoked by the dual-approval dispatcher (approve)
 * and the admin reject route (reject).
 *
 * Both handlers are IDEMPOTENT: they only act on an offer still in
 * ceo_approval_status='pending', so a cron retry, a double-click, or a
 * re-dispatch cannot re-run the release. Mirrors the guard pattern used by the
 * other dual-approval action handlers (battery-immobilisation, loan-restructuring).
 */
import { and, eq, inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import { nbfcFinancingOffers, nbfcLeadAssignments } from "@/lib/db/schema";
import { NEGOTIABLE_FIELDS, appendRound } from "@/lib/nbfc/offer-negotiation";

/** Approve: release the held offer to the dealer + advance the assignment. */
export async function applyFinancingOfferDeviationApproval(input: {
  offer_id: string;
  approver_user_id: string;
}): Promise<void> {
  const now = new Date();
  const [offer] = await db
    .update(nbfcFinancingOffers)
    .set({
      ceo_approval_status: "approved",
      ceo_decided_by: input.approver_user_id,
      ceo_decided_at: now,
      updated_at: now,
    })
    .where(
      and(
        eq(nbfcFinancingOffers.id, input.offer_id),
        eq(nbfcFinancingOffers.ceo_approval_status, "pending"),
      ),
    )
    .returning();
  if (!offer) return; // already decided / not found — idempotent no-op

  // Surface it on the dealer's compare-and-pick screen now that it's approved.
  await db
    .update(nbfcLeadAssignments)
    .set({ status: "offer_submitted", updated_at: now })
    .where(
      and(
        eq(nbfcLeadAssignments.id, offer.assignment_id),
        inArray(nbfcLeadAssignments.status, ["pending", "in_progress"]),
      ),
    );

  // E-238 — the submit route deliberately did NOT append a negotiation round
  // for this offer, because a round is only written once its terms are visible
  // to the dealer and this one was held here. Approval is that moment, so the
  // round is written now; without this the dealer's history would silently skip
  // every offer that ever went out of band.
  //
  // Best-effort and idempotent-by-index: the UNIQUE (offer_id, round) refuses a
  // duplicate if this handler is re-dispatched, and a failure here must not undo
  // an approval that has already released the offer.
  const round = offer.negotiation_round + 1;
  try {
    await db.transaction(async (tx) => {
      await appendRound(tx, {
        offer_id: offer.id,
        assignment_id: offer.assignment_id,
        lead_id: offer.lead_id,
        nbfc_id: offer.nbfc_id,
        tenant_id: offer.tenant_id,
        round,
        party: "nbfc",
        kind: "offer",
        terms: Object.fromEntries(NEGOTIABLE_FIELDS.map((f) => [f, offer[f]])),
        conditions: offer.conditions,
        created_by: offer.submitted_by,
        created_at: now,
      });
      await tx
        .update(nbfcFinancingOffers)
        .set({ negotiation_status: "open", negotiation_round: round, updated_at: now })
        .where(
          and(
            eq(nbfcFinancingOffers.id, offer.id),
            eq(nbfcFinancingOffers.negotiation_round, offer.negotiation_round),
          ),
        );
    });
  } catch (err) {
    console.error("[financing-offer-deviation] round append failed:", err);
  }
}

/** Reject: keep the offer held; record the decision. Credit officer must revise. */
export async function applyFinancingOfferDeviationRejection(input: {
  offer_id: string;
  approver_user_id: string;
}): Promise<void> {
  const now = new Date();
  await db
    .update(nbfcFinancingOffers)
    .set({
      ceo_approval_status: "rejected",
      ceo_decided_by: input.approver_user_id,
      ceo_decided_at: now,
      updated_at: now,
    })
    .where(
      and(
        eq(nbfcFinancingOffers.id, input.offer_id),
        eq(nbfcFinancingOffers.ceo_approval_status, "pending"),
      ),
    );
}
