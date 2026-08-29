/**
 * GET/POST /api/admin/nbfc-requests
 *
 *   GET  ?leadId=   → the NBFC request/message thread + per-NBFC verdicts for a
 *                     lead, for the admin "NBFC KYC Verification" card (Change 6).
 *   POST            → admin posts a direct message straight to an NBFC (Change 3),
 *                     no dealer round-trip. Body: JSON { assignmentId, message }
 *                     or multipart/form-data with the same two fields plus
 *                     files[] — documents the admin uploads for the NBFC (E-210).
 *
 * Auth: requireAdminAppUser().
 */
import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { nbfcDocumentVerifications, nbfcLeadAssignments } from "@/lib/db/schema";
import { requireAdminAppUser } from "@/lib/kyc/admin-workflow";
import {
  createNbfcDocRequest,
  listThreadForLead,
  NBFC_DOC_STATUS,
} from "@/lib/nbfc/doc-requests";
import { notifyNbfcOfUpdate } from "@/lib/nbfc/doc-request-notify";
import { getNbfcRequestSlaSettings } from "@/lib/nbfc/request-sla-settings";
import { uploadAdminAttachments } from "@/lib/nbfc/request-uploads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  assignmentId: z.string().uuid(),
  message: z.string().min(1).max(4000),
});

export async function GET(req: NextRequest) {
  try {
    const appUser = await requireAdminAppUser();
    if (!appUser) {
      return NextResponse.json(
        { success: false, error: { message: "Unauthorized" } },
        { status: 403 },
      );
    }
    const leadId = req.nextUrl.searchParams.get("leadId");
    if (!leadId) {
      return NextResponse.json(
        { success: false, error: { message: "leadId is required" } },
        { status: 400 },
      );
    }
    const thread = await listThreadForLead(leadId);
    // Only the verdicts that ASK something of iTarang reach the admin: a
    // rejection or a correction request. An NBFC approval ('verified') and an
    // untouched document ('pending') need no admin action, so they stay in the
    // NBFC's own workspace and never clutter the admin's NBFC Actions card.
    const verdicts = await db
      .select()
      .from(nbfcDocumentVerifications)
      .where(
        and(
          eq(nbfcDocumentVerifications.lead_id, leadId),
          inArray(nbfcDocumentVerifications.verdict, ["queried", "rejected"]),
        ),
      );
    // E-254 — the SLA settings and the server clock, so the card can render a
    // live "auto-forwards in …" countdown against the same clock the sweep
    // uses, and say plainly when no clock is running.
    const sla = await getNbfcRequestSlaSettings();
    return NextResponse.json({
      success: true,
      data: {
        thread,
        verdicts,
        sla: {
          enabled: sla.enabled,
          forwardSlaMinutes: sla.forwardSlaMinutes,
          pushSlaMinutes: sla.pushSlaMinutes,
          autoForwardToDealer: sla.autoForwardToDealer,
          autoPushToNbfc: sla.autoPushToNbfc,
        },
        serverNow: new Date().toISOString(),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load NBFC requests";
    return NextResponse.json({ success: false, error: { message } }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const appUser = await requireAdminAppUser();
    if (!appUser) {
      return NextResponse.json(
        { success: false, error: { message: "Unauthorized" } },
        { status: 403 },
      );
    }
    // Accept both shapes: JSON (message only) and multipart (message + files).
    const contentType = req.headers.get("content-type") ?? "";
    let form: FormData | null = null;
    let raw: unknown;
    if (contentType.includes("multipart/form-data")) {
      form = await req.formData();
      raw = {
        assignmentId: String(form.get("assignmentId") ?? ""),
        message: String(form.get("message") ?? "").trim(),
      };
    } else {
      raw = await req.json();
    }
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: { message: "Validation failed", details: parsed.error.flatten() } },
        { status: 400 },
      );
    }
    const { assignmentId, message } = parsed.data;

    const [assignment] = await db
      .select({
        id: nbfcLeadAssignments.id,
        lead_id: nbfcLeadAssignments.lead_id,
        nbfc_id: nbfcLeadAssignments.nbfc_id,
        tenant_id: nbfcLeadAssignments.tenant_id,
      })
      .from(nbfcLeadAssignments)
      .where(eq(nbfcLeadAssignments.id, assignmentId))
      .limit(1);
    if (!assignment) {
      return NextResponse.json(
        { success: false, error: { message: "Assignment not found" } },
        { status: 404 },
      );
    }

    // E-210 — any documents the admin attached ride along with the message.
    const attachments = form
      ? await uploadAdminAttachments(form, assignment.lead_id)
      : [];

    // A message is a wrapper row with no children — already pushed to the NBFC.
    const { id } = await createNbfcDocRequest({
      leadId: assignment.lead_id,
      assignmentId: assignment.id,
      nbfcId: assignment.nbfc_id,
      tenantId: assignment.tenant_id,
      requestType: "message",
      comments: message,
      raisedBy: appUser.id,
      initialStatus: NBFC_DOC_STATUS.PUSHED,
      attachments,
    });

    await notifyNbfcOfUpdate({
      tenantId: assignment.tenant_id,
      leadId: assignment.lead_id,
      requestId: id,
      isMessage: true,
    }).catch(() => {});

    return NextResponse.json({
      success: true,
      data: { id, attachments: attachments.length },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to post message";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: message.startsWith("BAD_REQUEST") ? 400 : 500 },
    );
  }
}
