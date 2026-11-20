/**
 * An NBFC raises a document request on an Acquire lead — the ONE write path,
 * shared by POST /api/nbfc/acquire/[leadId]/doc-requests and the CIBIL review
 * panel's "Request documents" (E-389).
 *
 * Every request lands with the iTarang admin ('nbfc_raised'), who answers it
 * himself or forwards it to the dealer / salesperson / customer (WhatsApp), and
 * the verified documents are pushed back to the NBFC.
 *
 * Side effects after the insert are best-effort: the admin bell + act-link
 * email, and the E-276 confirmation email to the raising NBFC.
 *
 * Lives outside doc-requests.ts because doc-request-notify.ts imports that
 * module (a circular import otherwise).
 */
import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { leads } from "@/lib/db/schema";
import { createNbfcDocRequest, NBFC_DOC_STATUS, type NbfcRequestType } from "@/lib/nbfc/doc-requests";
import { notifyAdminsOfNbfcRequest } from "@/lib/nbfc/doc-request-notify";
import { sendNbfcEventEmail } from "@/lib/nbfc/event-mailer";
import { dealerDisplayName } from "@/lib/notifications/emit";

export interface RaiseItem {
  doc_label: string;
  reason?: string | null;
  is_required?: boolean;
}

export function requestTypeLabel(t: string): string {
  return t === "correction"
    ? "Correction request"
    : t === "additional_docs"
      ? "Additional documents request"
      : t === "co_borrower"
        ? "Co-borrower request"
        : "Document request";
}

export async function raiseNbfcDocRequest(opts: {
  leadId: string;
  assignment: { id: string; nbfc_id: number };
  tenantId: string;
  /** For the admin notification copy ("<nbfc> raised a … request"). */
  nbfcName: string;
  raisedBy: string;
  requestType: NbfcRequestType;
  docFor?: "primary" | "co_borrower";
  targetDocKey?: string | null;
  comments?: string | null;
  items?: RaiseItem[];
  /** E-389 — set when raised from the CIBIL review panel. */
  cibilReviewId?: string | null;
  req?: NextRequest | Request;
}): Promise<{ id: string }> {
  const { leadId } = opts;
  const { id } = await createNbfcDocRequest({
    leadId,
    assignmentId: opts.assignment.id,
    nbfcId: opts.assignment.nbfc_id,
    tenantId: opts.tenantId,
    requestType: opts.requestType,
    docFor: opts.docFor ?? "primary",
    targetDocKey: opts.targetDocKey ?? null,
    comments: opts.comments ?? null,
    raisedBy: opts.raisedBy,
    initialStatus: NBFC_DOC_STATUS.RAISED,
    requestedItems: opts.items?.map((it) => ({
      doc_label: it.doc_label,
      reason: it.reason ?? undefined,
      is_required: it.is_required ?? true,
    })),
    cibilReviewId: opts.cibilReviewId ?? null,
  });

  // Best-effort: notify + email the admins (act link).
  await notifyAdminsOfNbfcRequest({
    leadId,
    requestId: id,
    requestType: opts.requestType,
    nbfcName: opts.nbfcName,
    comments: opts.comments ?? null,
    req: opts.req,
  }).catch(() => {});

  // E-276 — confirmation copy to the raising NBFC (+ global monitoring CC).
  const requestLabel = requestTypeLabel(opts.requestType);
  (async () => {
    const [leadRow] = await db
      .select({ full_name: leads.full_name, owner_name: leads.owner_name, dealer_id: leads.dealer_id })
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(1);
    await sendNbfcEventEmail({
      tenantId: opts.tenantId,
      leadId,
      subject: `iTarang — ${requestLabel} raised for Lead ${leadId}`,
      eventLabel: `Your ${requestLabel.toLowerCase()} for Lead ${leadId} has been raised and routed to the iTarang admin.`,
      customerName: leadRow?.full_name ?? leadRow?.owner_name ?? null,
      dealerName: await dealerDisplayName(leadRow?.dealer_id),
      files: (opts.items ?? []).map((it) => (it.reason ? `${it.doc_label} — ${it.reason}` : it.doc_label)),
      extraRows: [
        ["Request type", requestLabel],
        ["Comments", opts.comments],
      ],
      bodyHtml: `<p>Update: the admin will either fulfil the request himself or forward it to the dealer; you will be emailed again when the documents are pushed back to your dashboard.</p>`,
    });
  })().catch(() => {});

  return { id };
}
