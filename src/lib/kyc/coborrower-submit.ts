// BRD §2.9.3 step 5 — the dealer hands Step 3 (co-borrower KYC) back to iTarang.
//
// Extracted from POST /api/coborrower/[leadId]/submit-verification (E-264) so the
// WhatsApp bot and the web portal drive IDENTICAL submission logic — the same
// reasoning that put the consent flow behind a service in
// src/lib/kyc/consent-service.ts. A WhatsApp turn has no Supabase session, so it
// cannot call the route; and a second implementation would drift the moment one
// of them changed.
//
// The load-bearing write is `co_borrowers.verification_submitted_at`. Until it is
// non-null the admin case-review screen shows a gated banner and CANNOT approve
// or reject the co-borrower's documents — so a flow that uploads documents and
// forgets this leaves the admin looking at "awaiting dealer submission" forever.

import { and, eq, inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  adminVerificationQueue,
  coBorrowers,
  kycVerifications,
  leads,
} from "@/lib/db/schema";
import { createWorkflowId } from "@/lib/kyc/admin-workflow";

/**
 * Admin only acts on aadhaar / pan / bank for a co-borrower. Address and mobile
 * rows used to be inserted as placeholders but cluttered the dealer's
 * Verification Status table with rows admin never touches.
 */
const VERIFICATION_TYPES = ["aadhaar", "pan", "bank"] as const;

export interface SubmitCoBorrowerResult {
  verificationsInitiated: number;
  verifications: Array<{
    type: string;
    label: string;
    status: string;
    last_update: string;
    failed_reason: string | null;
  }>;
  new_kyc_status: string;
}

export async function submitCoBorrowerVerification(
  leadId: string,
): Promise<SubmitCoBorrowerResult> {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, "");

  // Idempotent: if the dealer re-submits (or admin re-opened the case and they
  // hit Submit again), we must NOT clobber an already-verified row with a fresh
  // 'initiating' placeholder. Rows are written with CANONICAL type names — no
  // 'coborrower_' prefix — so admin's upsertCoBorrowerVerification updates this
  // row instead of creating a parallel one. Legacy 'coborrower_*' rows are still
  // recognised here so an old case does not get a duplicate.
  const existingRows = await db
    .select({ verification_type: kycVerifications.verification_type })
    .from(kycVerifications)
    .where(
      and(
        eq(kycVerifications.lead_id, leadId),
        eq(kycVerifications.applicant, "co_borrower"),
        inArray(kycVerifications.verification_type, [
          "aadhaar",
          "pan",
          "bank",
          "coborrower_aadhaar",
          "coborrower_pan",
          "coborrower_bank",
        ]),
      ),
    );

  const canonicalExisting = new Set(
    existingRows.map((r) =>
      r.verification_type.startsWith("coborrower_")
        ? r.verification_type.slice("coborrower_".length)
        : r.verification_type,
    ),
  );

  const verifications: SubmitCoBorrowerResult["verifications"] = [];
  for (const type of VERIFICATION_TYPES) {
    if (canonicalExisting.has(type)) continue;
    const seq = Math.floor(Math.random() * 10000)
      .toString()
      .padStart(4, "0");
    await db.insert(kycVerifications).values({
      id: `KYCVER-COB-${dateStr}-${seq}`,
      lead_id: leadId,
      applicant: "co_borrower",
      verification_type: type,
      status: "initiating",
      api_provider: "decentro",
      submitted_at: now,
      created_at: now,
      updated_at: now,
    });
    verifications.push({
      type,
      label: `Co-Borrower ${type.charAt(0).toUpperCase() + type.slice(1)} Verification`,
      status: "initiating",
      last_update: now.toISOString(),
      failed_reason: null,
    });
  }

  await db
    .update(leads)
    .set({ kyc_status: "pending_itarang_reverification", updated_at: now })
    .where(eq(leads.id, leadId));

  // The gate the admin screen reads. See the header.
  await db
    .update(coBorrowers)
    .set({
      verification_submitted_at: now,
      kyc_status: "submitted",
      updated_at: now,
    })
    .where(eq(coBorrowers.lead_id, leadId));

  await db.insert(adminVerificationQueue).values({
    id: createWorkflowId("ADMQ", now),
    queue_type: "kyc_verification",
    lead_id: leadId,
    status: "pending_itarang_verification",
    priority: "high",
    submitted_at: now,
    created_at: now,
    updated_at: now,
  });

  return {
    verificationsInitiated: VERIFICATION_TYPES.length,
    verifications,
    new_kyc_status: "pending_itarang_reverification",
  };
}
