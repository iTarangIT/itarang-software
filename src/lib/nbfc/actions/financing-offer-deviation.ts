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
