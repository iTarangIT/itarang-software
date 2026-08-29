/**
 * POST /api/admin/nbfc-requests/verdicts/[verdictId]/respond  (multipart/form-data)
 *
 * Admin answers an NBFC per-document verdict (nbfc_document_verifications,
 * E-201) by uploading the customer document HIMSELF and sending it straight to
 * the NBFC — no dealer round-trip (E-210). Creates a `message` wrapper
 * (nbfc_doc_requests) born 'pushed_to_nbfc' carrying the uploaded files, linked
 * to the verdict via `verdict_id`, then notifies the NBFC tenant.
 *
 * Fields: message (required), files[] (1–5, ≤15 MB each, any type).
 * Auth: requireAdminAppUser().
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { nbfcDocumentVerifications } from "@/lib/db/schema";
import { requireAdminAppUser } from "@/lib/kyc/admin-workflow";
import { sendVerdictDocumentToNbfc } from "@/lib/nbfc/doc-requests";
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
  { params }: { params: Promise<{ verdictId: string }> },
) {
  try {
    const appUser = await requireAdminAppUser();
    if (!appUser) {
      return NextResponse.json(
        { success: false, error: { message: "Unauthorized" } },
        { status: 403 },
      );
    }

    const { verdictId } = await params;
    const id = Number(verdictId);
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json(
        { success: false, error: { message: "Invalid verdict id" } },
        { status: 400 },
      );
    }

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
    const [verdict] = await db
      .select({ lead_id: nbfcDocumentVerifications.lead_id })
      .from(nbfcDocumentVerifications)
      .where(eq(nbfcDocumentVerifications.id, id))
      .limit(1);
    if (!verdict) {
      return NextResponse.json(
        { success: false, error: { message: "Verdict not found" } },
        { status: 404 },
      );
    }

    const attachments = await uploadAdminAttachments(form, verdict.lead_id);
    if (attachments.length === 0) {
      return NextResponse.json(
        { success: false, error: { message: "Attach at least one document to send" } },
        { status: 400 },
      );
    }

    const result = await sendVerdictDocumentToNbfc({
      verdictId: id,
      adminUserId: appUser.id,
      message,
      attachments,
    });

    // Best-effort: the NBFC's bell + thread pick this up as an admin update.
    await notifyNbfcOfUpdate({
      tenantId: result.tenantId,
      leadId: result.leadId,
      requestId: result.requestId,
      isMessage: true,
    }).catch(() => {});

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to send the document";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: statusFromError(message) },
    );
  }
}
