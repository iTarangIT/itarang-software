/**
 * POST /api/admin/nbfc-requests/[id]/request-coborrower
 *
 * Admin one-click action on an NBFC-initiated 'co_borrower' request. Triggers the
 * standard dealer co-borrower KYC flow (same as the admin's Request Co-Borrower
 * KYC modal) using the NBFC's reason, then pushes the wrapper back to the NBFC so
 * it can track the outcome (the co-borrower appears under the NBFC's Co-Borrower
 * tab once the dealer completes KYC).
 *
 * Auth: requireAdminAppUser().
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { nbfcDocRequests } from "@/lib/db/schema";
import { requireAdminAppUser } from "@/lib/kyc/admin-workflow";
import { requestCoBorrowerForLead } from "@/lib/kyc/coborrower-request";
import { NBFC_DOC_STATUS } from "@/lib/nbfc/doc-requests";
import { notifyNbfcOfUpdate } from "@/lib/nbfc/doc-request-notify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const appUser = await requireAdminAppUser();
    if (!appUser) {
      return NextResponse.json(
        { success: false, error: { message: "Unauthorized" } },
        { status: 403 },
      );
    }
    const { id } = await params;

    const [wrapper] = await db
      .select({
        id: nbfcDocRequests.id,
        lead_id: nbfcDocRequests.lead_id,
        tenant_id: nbfcDocRequests.tenant_id,
        request_type: nbfcDocRequests.request_type,
        nbfc_comments: nbfcDocRequests.nbfc_comments,
        admin_notes: nbfcDocRequests.admin_notes,
      })
      .from(nbfcDocRequests)
      .where(eq(nbfcDocRequests.id, id))
      .limit(1);
    if (!wrapper) {
      return NextResponse.json(
        { success: false, error: { message: "NBFC request not found" } },
        { status: 404 },
      );
    }
    if (wrapper.request_type !== "co_borrower") {
      return NextResponse.json(
        {
          success: false,
          error: { message: "This action only applies to a co-borrower request" },
        },
        { status: 400 },
      );
    }

    const reason =
      (wrapper.nbfc_comments && wrapper.nbfc_comments.trim()) ||
      "Co-borrower requested by the NBFC partner.";

    const result = await requestCoBorrowerForLead(wrapper.lead_id, {
      reason,
      adminUserId: appUser.id,
    });
    if (!result) {
      return NextResponse.json(
        { success: false, error: { message: "Lead not found" } },
        { status: 404 },
      );
    }

    // Push the wrapper back to the NBFC — the ask is actioned; the co-borrower
    // KYC now proceeds via the standard dealer flow and surfaces under the NBFC
    // Co-Borrower tab. The NBFC can Acknowledge & close the thread.
    const now = new Date();
    const note = `Requested co-borrower from the dealer (${result.request_id}). Track the co-borrower's KYC under the Co-Borrower tab.`;
    await db
      .update(nbfcDocRequests)
      .set({
        status: NBFC_DOC_STATUS.PUSHED,
        admin_notes: wrapper.admin_notes
          ? `${wrapper.admin_notes}\n${note}`
          : note,
        reviewed_by: appUser.id,
        updated_at: now,
      })
      .where(eq(nbfcDocRequests.id, id));

    await notifyNbfcOfUpdate({
      tenantId: wrapper.tenant_id,
      leadId: wrapper.lead_id,
      requestId: id,
    }).catch(() => {});

    return NextResponse.json({
      success: true,
      data: {
        co_borrower_request_id: result.request_id,
        lead_status: result.lead_status,
        status: NBFC_DOC_STATUS.PUSHED,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to request co-borrower";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
