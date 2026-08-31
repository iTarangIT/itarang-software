/**
 * POST /api/nbfc/acquire/[leadId]/reject   body { note: string }
 *
 * E-275 — the NBFC rejects the whole file. The assignment goes 'declined'
 * (decision_reason 'nbfc_rejected'), any firm offer is withdrawn, and the
 * rejection waits with the ADMIN — the dealer hears nothing until an admin
 * forwards it (or the rejection SLA does). Role: credit_underwriting | nbfc_admin.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { leads, nbfcAuditLog, nbfcFinancingOffers, nbfcLeadAssignments } from "@/lib/db/schema";
import { clientError } from "@/lib/nbfc/http-error";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { isAssignmentDecided } from "@/lib/nbfc/offer-negotiation";
import { RECALLED_ERROR, isLeadRecalled } from "@/lib/nbfc/recall";
import { getNbfcRequestSlaSettings, rejectionDueAtFrom } from "@/lib/nbfc/request-sla-settings";
import { getActiveAssignment } from "@/lib/nbfc/vkyc";
import { sendNbfcEventEmail } from "@/lib/nbfc/event-mailer";
import { dealerDisplayName, tenantDisplayName } from "@/lib/notifications/emit";
import { notifyNbfcRejectedApplication } from "@/lib/notifications/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  if (msg.startsWith("CONFLICT")) return 409;
  return 500;
}

const Body = z.object({ note: z.string().trim().min(1).max(2000) });

export async function POST(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
  try {
    const { leadId } = await params;
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: invalid JSON" }, { status: 400 });
    }
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: "VALIDATION", issues: parsed.error.issues }, { status: 400 });
    }
    const note = parsed.data.note;

    const actor = await resolveActor(req.headers);
    if (actor.role !== "credit_underwriting" && actor.role !== "nbfc_admin") {
      return NextResponse.json(
        { ok: false, error: `FORBIDDEN: role '${actor.role}' cannot reject a file; credit_underwriting or nbfc_admin required` },
        { status: 403 },
      );
    }

    const assignment = await getActiveAssignment(leadId, actor.tenant_id);
    if (!assignment) {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: no assignment for this lead under this tenant" }, { status: 400 });
    }
    if (isAssignmentDecided(assignment.status)) {
      return NextResponse.json(
        { ok: false, error: `BAD_REQUEST: this assignment is already decided (status '${assignment.status}')` },
        { status: 400 },
      );
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
    if (isLeadRecalled(lead)) {
      return NextResponse.json({ ok: false, error: RECALLED_ERROR }, { status: 409 });
    }

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

    return NextResponse.json({
      ok: true,
      status: "declined",
      rejection_admin_due_at: dueAt?.toISOString() ?? null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: statusFromError(msg) });
  }
}
