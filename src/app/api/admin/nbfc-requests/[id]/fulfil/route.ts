/**
 * POST /api/admin/nbfc-requests/[id]/fulfil  (multipart/form-data)
 *
 * The admin answers an NBFC document request HIMSELF — he already holds the
 * file, so he uploads it and it goes straight back to the NBFC instead of being
 * forwarded down to the dealer/customer. The other half of the gate is
 * /forward, which sends the same request down when the admin does NOT have it.
 *
 * Only a request still with the admin ('nbfc_raised' / 'admin_review') can be
 * answered this way; the service enforces that.
 *
 * Fields: message (required), files[] (1–5, ≤15 MB each, any type).
 * Auth: requireAdminAppUser().
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { nbfcDocRequests } from "@/lib/db/schema";
import { requireAdminAppUser } from "@/lib/kyc/admin-workflow";
import { fulfilNbfcDocRequestByAdmin } from "@/lib/nbfc/doc-requests";
import { notifyNbfcOfUpdate } from "@/lib/nbfc/doc-request-notify";
import { uploadAdminAttachments } from "@/lib/nbfc/request-uploads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function statusFromError(msg: string): number {
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

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

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return NextResponse.json(
        { success: false, error: { message: "Expected multipart/form-data" } },
        { status: 400 },
      );
    }
    const message = String(form.get("message") ?? "").trim();
    if (!message) {
      return NextResponse.json(
        { success: false, error: { message: "A message for the NBFC is required" } },
        { status: 400 },
      );
    }

    // The lead scopes the storage key — resolve it before touching the bucket.
    const [wrapper] = await db
      .select({ lead_id: nbfcDocRequests.lead_id })
      .from(nbfcDocRequests)
      .where(eq(nbfcDocRequests.id, id))
      .limit(1);
    if (!wrapper) {
      return NextResponse.json(
        { success: false, error: { message: "NBFC request not found" } },
        { status: 404 },
      );
    }

    const attachments = await uploadAdminAttachments(form, wrapper.lead_id);
    if (attachments.length === 0) {
      return NextResponse.json(
        { success: false, error: { message: "Attach at least one document to send" } },
        { status: 400 },
      );
    }

    const result = await fulfilNbfcDocRequestByAdmin({
      requestId: id,
      adminUserId: appUser.id,
      message,
      attachments,
    });

    // Best-effort: the NBFC's bell + thread pick this up as an admin update.
    await notifyNbfcOfUpdate({
      tenantId: result.tenantId,
      leadId: result.leadId,
      requestId: id,
    }).catch(() => {});

    return NextResponse.json({
      success: true,
      data: { status: "pushed_to_nbfc", attachmentCount: result.attachmentCount },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to send the document";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: statusFromError(message) },
    );
  }
}
