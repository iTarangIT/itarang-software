/**
 * GET/POST /api/admin/nbfc-requests
 *
 *   GET  ?leadId=   → the NBFC request/message thread + per-NBFC verdicts for a
 *                     lead, for the admin "NBFC KYC Verification" card (Change 6).
 *   POST            → admin posts a direct message straight to an NBFC (Change 3),
 *                     no dealer round-trip. Body: { assignmentId, message }.
 *
 * Auth: requireAdminAppUser().
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
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
    const verdicts = await db
      .select()
      .from(nbfcDocumentVerifications)
      .where(eq(nbfcDocumentVerifications.lead_id, leadId));
    return NextResponse.json({ success: true, data: { thread, verdicts } });
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
    const parsed = Body.safeParse(await req.json());
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
    });

    await notifyNbfcOfUpdate({
      tenantId: assignment.tenant_id,
      leadId: assignment.lead_id,
      requestId: id,
      isMessage: true,
    }).catch(() => {});

    return NextResponse.json({ success: true, data: { id } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to post message";
    return NextResponse.json({ success: false, error: { message } }, { status: 500 });
  }
}
