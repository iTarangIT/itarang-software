/**
 * Decline this NBFC's assignment on a lead ("Reject file"). Shared by
 * POST /api/nbfc/acquire/[leadId]/reject and the E-387 CIBIL rejection
 * (POST /api/nbfc/acquire/[leadId]/cibil-review/decide), so both close the file
 * the same way: assignment → declined, offers withdrawn, audit row, admin
 * notification, confirmation email.
 *
 * Throws prefix-tagged errors (BAD_REQUEST / CONFLICT) for the caller's
 * statusFromError.
 */
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { leads, nbfcAuditLog, nbfcFinancingOffers, nbfcLeadAssignments } from "@/lib/db/schema";
import { isAssignmentDecided } from "@/lib/nbfc/offer-negotiation";
import { RECALLED_ERROR, isLeadRecalled } from "@/lib/nbfc/recall";
import { getNbfcRequestSlaSettings, rejectionDueAtFrom } from "@/lib/nbfc/request-sla-settings";
import { getActiveAssignment } from "@/lib/nbfc/vkyc";
import { sendNbfcEventEmail } from "@/lib/nbfc/event-mailer";
import { dealerDisplayName, tenantDisplayName } from "@/lib/notifications/emit";
import { notifyNbfcRejectedApplication } from "@/lib/notifications/events";

export async function rejectNbfcFile(opts: {
  actor: { tenant_id: string; user_id: string };
  leadId: string;
  note: string;
  /** Extra audit context, e.g. { via: "cibil_review", cibil_review_id }. */
  auditExtra?: Record<string, unknown>;
}): Promise<{ dueAt: Date | null }> {
  const { actor, leadId, note } = opts;

  const assignment = await getActiveAssignment(leadId, actor.tenant_id);
  if (!assignment) throw new Error("BAD_REQUEST: no assignment for this lead under this tenant");
  if (isAssignmentDecided(assignment.status)) {
    throw new Error(`BAD_REQUEST: this assignment is already decided (status '${assignment.status}')`);
  }
  const [lead] = await db
    .select({
      recalled_at: leads.recalled_at,
      resubmitted_at: leads.resubmitted_at,
      full_name: leads.full_name,
      owner_name: leads.owner_name,
      dealer_id: leads.dealer_id,
    })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);
  if (isLeadRecalled(lead)) throw new Error(RECALLED_ERROR);

  const now = new Date();
  const dueAt = rejectionDueAtFrom(now, await getNbfcRequestSlaSettings());

  await db.transaction(async (tx) => {
    await tx
      .update(nbfcLeadAssignments)
      .set({
        status: "declined",
        decided_at: now,
        decision_reason: "nbfc_rejected",
        rejection_note: note,
        rejection_admin_due_at: dueAt,
        rejection_forwarded_at: null,
        rejection_forward_source: null,
        updated_at: now,
      })
      .where(eq(nbfcLeadAssignments.id, assignment.id));
    await tx
      .update(nbfcFinancingOffers)
      .set({ status: "withdrawn", updated_at: now })
      .where(eq(nbfcFinancingOffers.assignment_id, assignment.id));
    await tx.insert(nbfcAuditLog).values({
      tenant_id: actor.tenant_id,
      user_id: actor.user_id,
      action_type: "application_rejected",
      action_id: assignment.id,
      before_state: { lead_id: leadId, nbfc_id: assignment.nbfc_id, status: assignment.status },
      after_state: {
        lead_id: leadId,
        nbfc_id: assignment.nbfc_id,
        status: "declined",
        decision_reason: "nbfc_rejected",
        note,
        rejection_admin_due_at: dueAt?.toISOString() ?? null,
        ...(opts.auditExtra ?? {}),
      },
      created_at: now,
    });
  });

  const nbfcName = await tenantDisplayName(actor.tenant_id);
  await notifyNbfcRejectedApplication({
    leadId,
    assignmentId: assignment.id,
    nbfcName,
    note,
  });

  // E-276 — confirmation copy to the rejecting NBFC (+ global monitoring CC).
  sendNbfcEventEmail({
    tenantId: actor.tenant_id,
    leadId,
    subject: `iTarang — Application rejected by ${nbfcName} (Lead ${leadId})`,
    eventLabel: `${nbfcName} has rejected the loan application for Lead ${leadId}.`,
    customerName: lead?.full_name ?? lead?.owner_name ?? null,
    dealerName: await dealerDisplayName(lead?.dealer_id),
    extraRows: [
      ["Rejected by", nbfcName],
      ["Rejection reason", note],
    ],
    bodyHtml: `<p>Update: the rejection is recorded and now sits with the iTarang admin, who will forward the decision to the dealer (the dealer may then re-route the file to another lender).</p>`,
  }).catch(() => {});

  return { dueAt };
}
