/**
 * Upsert the NBFC's OWN per-document KYC verdict (Change 1) into
 * `nbfc_document_verifications` — one row per (assignment, doc_for, doc_key).
 * This is the shared write used by the rich-card Accept/Reject mirror routes
 * (`kyc/verification/*`), the multipart verdict route (`verify-doc/action`) and
 * the plain `verify-doc` POST.
 *
 * The NBFC verdict is deliberately separate from the shared admin_action on
 * `kyc_verifications` — re-running Decentro refreshes the objective result but
 * never the admin's decision, and the NBFC records its own opinion here.
 *
 * E-254 — this is ALSO where the leg-1 SLA clock on a verdict is armed. A
 * 'queried' (correction requested) or 'rejected' verdict that the admin has not
 * yet forwarded carries `sla_due_at`; when it passes, the sweep forwards the
 * verdict to the dealer itself. The rules, expressed in the ON CONFLICT clause:
 *   - new verdict is queried/rejected AND forwarded_at IS NULL → keep the clock
 *     that is already running (a re-save must not restart it), else start one;
 *   - anything else (verified / pending, or already forwarded) → no clock.
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { nbfcDocumentVerifications } from "@/lib/db/schema";
import {
  forwardDueAtFrom,
  getNbfcRequestSlaSettings,
} from "@/lib/nbfc/request-sla-settings";

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

/** The verdicts that ask something of iTarang and therefore carry a clock. */
export function verdictNeedsAdmin(verdict: NbfcVerdict): boolean {
  return verdict === "queried" || verdict === "rejected";
}

export async function upsertNbfcVerdict(opts: {
  leadId: string;
  assignmentId: string;
  /** nbfc.id — an integer (the column is `integer`; callers pass assignment.nbfc_id). */
  nbfcId: number;
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
  // E-254 — the deadline this verdict WOULD carry if it needs the admin. Null
  // while the feature is off, so the CASE below resolves to NULL either way.
  const due = verdictNeedsAdmin(opts.verdict)
    ? forwardDueAtFrom(now, await getNbfcRequestSlaSettings())
    : null;
  const dueSql = due ? sql`${due.toISOString()}::timestamptz` : sql`NULL::timestamptz`;

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
      sla_due_at: due,
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
        // E-254 — see the header. `due` is NULL when the new verdict does not
        // need the admin (or the feature is off), which the CASE handles too.
        sla_due_at: verdictNeedsAdmin(opts.verdict)
          ? sql`CASE WHEN ${nbfcDocumentVerifications.forwarded_at} IS NULL
                     THEN COALESCE(${nbfcDocumentVerifications.sla_due_at}, ${dueSql})
                     ELSE NULL END`
          : null,
        updated_at: now,
      },
    });
}
