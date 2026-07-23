/**
 * Upsert the NBFC's OWN per-document KYC verdict (Change 1) into
 * `nbfc_document_verifications` — one row per (assignment, doc_for, doc_key).
 * This is the shared write used by the rich-card Accept/Reject mirror routes
 * (`kyc/verification/*`) and mirrors the existing `verify-doc` POST logic.
 *
 * The NBFC verdict is deliberately separate from the shared admin_action on
 * `kyc_verifications` — re-running Decentro refreshes the objective result but
 * never the admin's decision, and the NBFC records its own opinion here.
 */
import { db } from "@/lib/db";
import { nbfcDocumentVerifications } from "@/lib/db/schema";

export type NbfcVerdict = "pending" | "verified" | "queried" | "rejected";

/** A supporting file the NBFC attached to a verdict (E-207). */
export interface VerdictAttachment {
  url: string;
  name: string;
  type: string;
  size: number;
}

export function verdictFromAction(action: string): NbfcVerdict | null {
  if (action === "accept") return "verified";
  if (action === "reject") return "rejected";
  return null;
}

export async function upsertNbfcVerdict(opts: {
  leadId: string;
  assignmentId: string;
  nbfcId: string;
  tenantId: string;
  docFor: "primary" | "co_borrower";
  docKey: string;
  verdict: NbfcVerdict;
  notes?: string | null;
  // When provided, replaces the row's attachment list. Omit to leave unchanged.
  attachments?: VerdictAttachment[];
  verifiedBy: string;
}): Promise<void> {
  const now = new Date();
  await db
    .insert(nbfcDocumentVerifications)
    .values({
      lead_id: opts.leadId,
      assignment_id: opts.assignmentId,
      nbfc_id: opts.nbfcId,
      tenant_id: opts.tenantId,
      doc_for: opts.docFor,
      doc_key: opts.docKey,
      verdict: opts.verdict,
      notes: opts.notes ?? null,
      attachments: opts.attachments ?? [],
      verified_by: opts.verifiedBy,
      verified_at: now,
      created_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: [
        nbfcDocumentVerifications.assignment_id,
        nbfcDocumentVerifications.doc_for,
        nbfcDocumentVerifications.doc_key,
      ],
      set: {
        verdict: opts.verdict,
        notes: opts.notes ?? null,
        // Only overwrite attachments when the caller supplied a new list.
        ...(opts.attachments !== undefined ? { attachments: opts.attachments } : {}),
        verified_by: opts.verifiedBy,
        verified_at: now,
        updated_at: now,
      },
    });
}
