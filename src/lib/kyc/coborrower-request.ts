/**
 * Shared "Request Co-Borrower KYC" logic (BRD §2.9.3).
 *
 * Extracted from the admin route `api/admin/kyc/[leadId]/step3/request-coborrower`
 * so it can also be driven by the NBFC-initiated co-borrower flow (the admin
 * one-clicks "Request co-borrower from dealer" on an NBFC 'co_borrower' request).
 *
 * Creates a stub `coBorrowers` row (or wipes it for a replacement), opens a
 * `coBorrowerRequests` row (closing any prior open one), flips the lead into the
 * appropriate Step-3 co-borrower waiting state, releases the dealer-edits lock so
 * the dealer's interim co-borrower KYC page unlocks, and writes an audit row.
 */
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  auditLogs,
  coBorrowerRequests,
  coBorrowers,
  kycVerificationMetadata,
  leads,
} from "@/lib/db/schema";
import { createWorkflowId } from "@/lib/kyc/admin-workflow";

export interface RequestCoBorrowerResult {
  request_id: string;
  attempt_number: number;
  lead_status: string;
}

/**
 * @returns null if the lead does not exist.
 */
export async function requestCoBorrowerForLead(
  leadId: string,
  opts: {
    reason: string;
    /** NULL when the E-254 NBFC request SLA sweep acts (system actor). */
    adminUserId: string | null;
    isReplacement?: boolean;
  },
): Promise<RequestCoBorrowerResult | null> {
  const { reason, adminUserId, isReplacement = false } = opts;

  const [lead] = await db
    .select({ id: leads.id, kyc_status: leads.kyc_status })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);
  if (!lead) return null;

  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, "");
  const seq = Math.floor(Math.random() * 10000)
    .toString()
    .padStart(4, "0");

  // Find or stub a co-borrower row. If we are replacing, wipe the identity fields
  // so the dealer can enter fresh details.
  const [existingCob] = await db
    .select()
    .from(coBorrowers)
    .where(eq(coBorrowers.lead_id, leadId))
    .limit(1);

  if (!existingCob) {
    await db.insert(coBorrowers).values({
      id: `COBOR-${dateStr}-${seq}`,
      lead_id: leadId,
      full_name: "",
      phone: "",
      kyc_status: "not_started",
      created_at: now,
      updated_at: now,
    });
  } else if (isReplacement) {
    await db
      .update(coBorrowers)
      .set({
        full_name: "",
        father_or_husband_name: null,
        dob: null,
        phone: "",
        permanent_address: null,
        current_address: null,
        is_current_same: false,
        pan_no: null,
        aadhaar_no: null,
        kyc_status: "not_started",
        consent_status: "awaiting_signature",
        verification_submitted_at: null,
        updated_at: now,
      })
      .where(eq(coBorrowers.id, existingCob.id));
  }

  // Attempt number = (max attempt on existing requests) + 1.
  const prior = await db
    .select({ attempt_number: coBorrowerRequests.attempt_number })
    .from(coBorrowerRequests)
    .where(eq(coBorrowerRequests.lead_id, leadId))
    .orderBy(desc(coBorrowerRequests.attempt_number))
    .limit(1);
  const nextAttempt = (prior[0]?.attempt_number ?? 0) + 1;

  // Close any open prior requests so only one is active at a time.
  await db
    .update(coBorrowerRequests)
    .set({ status: "replaced", updated_at: now })
    .where(
      and(
        eq(coBorrowerRequests.lead_id, leadId),
        eq(coBorrowerRequests.status, "open"),
      ),
    );

  const requestId = `COBREQ-${dateStr}-${seq}`;
  await db.insert(coBorrowerRequests).values({
    id: requestId,
    lead_id: leadId,
    attempt_number: nextAttempt,
    reason,
    status: "open",
    created_by: adminUserId,
    created_at: now,
    updated_at: now,
  });

  const currentStatus = lead.kyc_status ?? "";
  let nextStatus: string;
  if (isReplacement) {
    nextStatus = "awaiting_co_borrower_replacement";
  } else if (
    currentStatus === "awaiting_additional_docs" ||
    currentStatus === "awaiting_both"
  ) {
    nextStatus = "awaiting_both";
  } else {
    nextStatus = "awaiting_co_borrower_kyc";
  }

  await db
    .update(leads)
    .set({ kyc_status: nextStatus, has_co_borrower: true, updated_at: now })
    .where(eq(leads.id, leadId));

  // Release the dealer-edits lock so the dealer can upload co-borrower documents.
  const metaRows = await db
    .select({ lead_id: kycVerificationMetadata.lead_id })
    .from(kycVerificationMetadata)
    .where(eq(kycVerificationMetadata.lead_id, leadId))
    .limit(1);
  if (metaRows.length > 0) {
    await db
      .update(kycVerificationMetadata)
      .set({ dealer_edits_locked: false, updated_at: now })
      .where(eq(kycVerificationMetadata.lead_id, leadId));
  } else {
    await db.insert(kycVerificationMetadata).values({
      lead_id: leadId,
      dealer_edits_locked: false,
      created_at: now,
      updated_at: now,
    });
  }

  await db.insert(auditLogs).values({
    id: createWorkflowId("AUDIT", now),
    entity_type: "step3_request_coborrower",
    entity_id: leadId,
    action: isReplacement ? "replacement" : "create",
    changes: {
      request_id: requestId,
      attempt_number: nextAttempt,
      reason,
      previous_status: currentStatus,
      new_status: nextStatus,
    },
    performed_by: adminUserId,
    timestamp: now,
  });

  return {
    request_id: requestId,
    attempt_number: nextAttempt,
    lead_status: nextStatus,
  };
}
