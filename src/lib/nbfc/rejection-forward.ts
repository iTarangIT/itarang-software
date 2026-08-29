/**
 * E-275 — forward an NBFC's file rejection to the dealer.
 *
 * The NBFC reject route parks the rejection on the assignment
 * (status='declined', rejection_note, rejection_admin_due_at) and tells only
 * the admins. THIS is the one hop that reaches the dealer, and it has exactly
 * two callers: the admin's "Forward to dealer" click (source 'admin') and the
 * request-SLA sweep when the admin window elapses (source 'system'). Both
 * stamp `rejection_forwarded_at` + `rejection_forward_source` so the card can
 * say who did it, and clear the deadline so the sweep never re-claims the row.
 */
import { and, eq, isNull } from "drizzle-orm";

import { db } from "@/lib/db";
import { auditLogs, leads, nbfc, nbfcLeadAssignments } from "@/lib/db/schema";
import { createWorkflowId } from "@/lib/kyc/admin-workflow";
import { tenantDisplayName } from "@/lib/notifications/emit";
import { notifyLeadRejectedByNbfc } from "@/lib/notifications/events";
import { ADMIN_PARTY, SYSTEM_PARTY } from "@/lib/notifications/provenance";

export type ForwardRejectionResult = {
  assignmentId: string;
  leadId: string;
  nbfcName: string;
  note: string;
  forwardedAt: Date;
};

export async function forwardRejectionToDealer(p: {
  assignmentId: string;
  source: "admin" | "system";
  adminUserId: string | null;
}): Promise<ForwardRejectionResult> {
  const [assignment] = await db
    .select()
    .from(nbfcLeadAssignments)
    .where(eq(nbfcLeadAssignments.id, p.assignmentId))
    .limit(1);
  if (!assignment) throw new Error("NOT_FOUND: assignment not found");
  if (assignment.status !== "declined" || assignment.decision_reason !== "nbfc_rejected") {
    throw new Error("BAD_REQUEST: this assignment was not rejected by the NBFC");
  }
  if (assignment.rejection_forwarded_at) {
    throw new Error(
      `BAD_REQUEST: this rejection was already forwarded to the dealer by ${assignment.rejection_forward_source ?? "admin"}`,
    );
  }

  const [lead] = await db
    .select({ id: leads.id })
    .from(leads)
    .where(eq(leads.id, assignment.lead_id))
    .limit(1);
  if (!lead) throw new Error("NOT_FOUND: lead not found");

  const [nbfcRow] = await db
    .select({ short_name: nbfc.short_name })
    .from(nbfc)
    .where(eq(nbfc.id, assignment.nbfc_id))
    .limit(1);
  const nbfcName = nbfcRow?.short_name ?? (await tenantDisplayName(assignment.tenant_id));
  const note = (assignment.rejection_note ?? "").trim();
  const now = new Date();

  // The forwarded_at IS NULL guard makes a double click / a concurrent sweep
  // claim a no-op rather than a second dealer notification.
  const updated = await db
    .update(nbfcLeadAssignments)
    .set({
      rejection_forwarded_at: now,
      rejection_forward_source: p.source,
      rejection_admin_due_at: null,
      updated_at: now,
    })
    .where(
      and(
        eq(nbfcLeadAssignments.id, assignment.id),
        isNull(nbfcLeadAssignments.rejection_forwarded_at),
      ),
    )
    .returning({ id: nbfcLeadAssignments.id });
  if (updated.length === 0) {
    throw new Error("BAD_REQUEST: this rejection was already forwarded to the dealer");
  }

  try {
    await db.insert(auditLogs).values({
      id: createWorkflowId("AUDIT", now),
      entity_type: "nbfc_rejection",
      entity_id: assignment.id,
      action: p.source === "system" ? "auto_forwarded" : "forwarded",
      changes: {
        lead_id: assignment.lead_id,
        nbfc_id: assignment.nbfc_id,
        nbfc_name: nbfcName,
        note,
        source: p.source,
      },
      performed_by: p.adminUserId,
      timestamp: now,
    });
  } catch (err) {
    console.error("[rejection-forward] audit insert failed:", err);
  }

  await notifyLeadRejectedByNbfc({
    leadId: assignment.lead_id,
    nbfcName,
    note,
    from: p.source === "system" ? SYSTEM_PARTY : ADMIN_PARTY,
  });

  // The dealer's WhatsApp copy — best-effort, never awaited into the result.
  void import("@/lib/whatsapp/step4-flow")
    .then((m) => m.pushRejectionToWhatsApp(assignment.lead_id, { nbfcName, note }))
    .catch((err) => console.error("[rejection-forward] WhatsApp push failed:", err));

  return { assignmentId: assignment.id, leadId: assignment.lead_id, nbfcName, note, forwardedAt: now };
}
