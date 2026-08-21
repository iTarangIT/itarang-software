/**
 * NBFC Acquire — composite admin actions on a request wrapper that need BOTH
 * the request service (doc-requests.ts) and the notification helpers
 * (doc-request-notify.ts). Kept out of doc-requests.ts because
 * doc-request-notify.ts already imports from it — putting these there would
 * close an import cycle.
 *
 * Shared by the admin routes and the E-254 SLA sweep so a system action is,
 * step for step, the same thing an admin's click does.
 */
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { nbfcDocRequests } from "@/lib/db/schema";
import { requestCoBorrowerForLead } from "@/lib/kyc/coborrower-request";
import { notifyCoBorrowerRequested } from "@/lib/notifications/events";
import { notifyNbfcOfUpdate } from "@/lib/nbfc/doc-request-notify";
import {
  type ActionSource,
  NBFC_DOC_STATUS,
} from "@/lib/nbfc/doc-requests";

/**
 * One-click action on an NBFC-initiated 'co_borrower' request (E-204).
 * Triggers the standard dealer co-borrower KYC flow using the NBFC's reason,
 * then pushes the wrapper back to the NBFC so it can track the outcome. Also
 * what the E-254 sweep runs when the admin's leg-1 window expires.
 */
export async function actionNbfcCoBorrowerRequest(opts: {
  requestId: string;
  /** NULL when the SLA sweep acts (E-254) — pair it with source:'system'. */
  adminUserId: string | null;
  source?: ActionSource;
}): Promise<{
  co_borrower_request_id: string;
  lead_status: string;
  status: string;
}> {
  const [wrapper] = await db
    .select({
      id: nbfcDocRequests.id,
      lead_id: nbfcDocRequests.lead_id,
      tenant_id: nbfcDocRequests.tenant_id,
      request_type: nbfcDocRequests.request_type,
      nbfc_comments: nbfcDocRequests.nbfc_comments,
      admin_notes: nbfcDocRequests.admin_notes,
      auto_pushed_at: nbfcDocRequests.auto_pushed_at,
    })
    .from(nbfcDocRequests)
    .where(eq(nbfcDocRequests.id, opts.requestId))
    .limit(1);
  if (!wrapper) throw new Error("NOT_FOUND: NBFC request not found");
  if (wrapper.request_type !== "co_borrower") {
    throw new Error(
      "BAD_REQUEST: This action only applies to a co-borrower request",
    );
  }

  const reason =
    (wrapper.nbfc_comments && wrapper.nbfc_comments.trim()) ||
    "Co-borrower requested by the NBFC partner.";

  const result = await requestCoBorrowerForLead(wrapper.lead_id, {
    reason,
    adminUserId: opts.adminUserId,
  });
  if (!result) throw new Error("NOT_FOUND: Lead not found");

  // Push the wrapper back to the NBFC — the ask is actioned; the co-borrower
  // KYC now proceeds via the standard dealer flow and surfaces under the NBFC
  // Co-Borrower tab. The NBFC can Acknowledge & close the thread.
  const now = new Date();
  const source: ActionSource = opts.source ?? "admin";
  const note =
    (source === "system"
      ? "Auto-actioned by the NBFC request SLA: requested co-borrower from the dealer"
      : "Requested co-borrower from the dealer") +
    ` (${result.request_id}). Track the co-borrower's KYC under the Co-Borrower tab.`;
  await db
    .update(nbfcDocRequests)
    .set({
      status: NBFC_DOC_STATUS.PUSHED,
      admin_notes: wrapper.admin_notes ? `${wrapper.admin_notes}\n${note}` : note,
      reviewed_by: opts.adminUserId,
      sla_due_at: null,
      // The co-borrower ask has no forward leg — actioning it IS the push.
      forward_source: source,
      push_source: source,
      auto_forwarded_at: source === "system" ? now : undefined,
      auto_pushed_at: source === "system" ? now : wrapper.auto_pushed_at,
      updated_at: now,
    })
    .where(eq(nbfcDocRequests.id, opts.requestId));

  await notifyNbfcOfUpdate({
    tenantId: wrapper.tenant_id,
    leadId: wrapper.lead_id,
    requestId: opts.requestId,
  }).catch(() => {});

  // The dealer is the one who has to DO something here — add the co-borrower
  // and their KYC.
  await notifyCoBorrowerRequested({
    leadId: wrapper.lead_id,
    reason,
  }).catch(() => {});

  return {
    co_borrower_request_id: result.request_id,
    lead_status: result.lead_status,
    status: NBFC_DOC_STATUS.PUSHED,
  };
}
