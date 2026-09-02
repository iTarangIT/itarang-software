/**
 * POST /api/admin/nbfc-requests/[id]/push
 *
 * Admin pushes a completed request up to the NBFC (Change 2, hop 7). Requires
 * every child document to be verified. Notifies the NBFC tenant.
 *
 * Auth: requireAdminAppUser().
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { leads, nbfcDocRequests, otherDocumentRequests } from "@/lib/db/schema";
import { dealerDisplayName } from "@/lib/notifications/emit";
import { requireAdminAppUser } from "@/lib/kyc/admin-workflow";
import { pushNbfcDocRequest } from "@/lib/nbfc/doc-requests";
import { notifyNbfcOfUpdate } from "@/lib/nbfc/doc-request-notify";
import { sendNbfcEventEmail } from "@/lib/nbfc/event-mailer";

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

    const [wrapper] = await db
      .select({
        id: nbfcDocRequests.id,
        lead_id: nbfcDocRequests.lead_id,
        tenant_id: nbfcDocRequests.tenant_id,
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

    await pushNbfcDocRequest({ requestId: id, adminUserId: appUser.id });

    await notifyNbfcOfUpdate({
      tenantId: wrapper.tenant_id,
      leadId: wrapper.lead_id,
      requestId: id,
    }).catch(() => {});

    // E-276 — contact-email copy to the NBFC (+ global monitoring CC).
    (async () => {
      const [leadRow] = await db
        .select({
          full_name: leads.full_name,
          owner_name: leads.owner_name,
          dealer_id: leads.dealer_id,
        })
        .from(leads)
        .where(eq(leads.id, wrapper.lead_id))
        .limit(1);
      const children = await db
        .select({
          doc_label: otherDocumentRequests.doc_label,
          document_name: otherDocumentRequests.document_name,
        })
        .from(otherDocumentRequests)
        .where(eq(otherDocumentRequests.nbfc_request_id, id));
      await sendNbfcEventEmail({
        tenantId: wrapper.tenant_id,
        leadId: wrapper.lead_id,
        subject: `iTarang — Requested documents delivered to your dashboard (Lead ${wrapper.lead_id})`,
        eventLabel: `The iTarang admin has completed your document request for Lead ${wrapper.lead_id} and pushed the verified documents to your NBFC dashboard.`,
        customerName: leadRow?.full_name ?? leadRow?.owner_name ?? null,
        dealerName: await dealerDisplayName(leadRow?.dealer_id),
        files: children.map((c) => c.document_name || c.doc_label),
        bodyHtml: `<p>Update: open the lead's <b>Documents</b> tab in your NBFC dashboard to review the delivered files.</p>`,
      });
    })().catch(() => {});

    return NextResponse.json({ success: true, data: { status: "pushed_to_nbfc" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to push to NBFC";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: statusFromError(message) },
    );
  }
}
