/**
 * Where buyback's objects live in S3.
 *
 * One logical bucket for the whole module. `dealer-documents` already exists and
 * is where the intake photos went in Sprint 1 — the physical bucket is a single
 * AWS_S3_BUCKET and the "logical bucket" is really a key prefix (see
 * src/lib/storage/s3.ts:s3Key), so this is a folder, not new infrastructure.
 *
 * Keys are always SERVER-DERIVED. A client never chooses where its bytes land:
 * a caller who could pass `../` or another dealer's request id into a key would
 * be able to overwrite documents that are not theirs.
 */

import { extensionFor } from "./upload";

export const BUYBACK_BUCKET = "dealer-documents";

/** The masked quotation emailed to one vendor (M09). */
export function quotationKey(requestId: string, threadId: string): string {
  return `buyback/${requestId}/quotations/${threadId}.pdf`;
}

/** The PO iTarang issues to the dealer, or the one a vendor sends us (M11). */
export function poKey(requestId: string, leg: "DEALER" | "VENDOR", poId: string): string {
  return `buyback/${requestId}/po/${leg.toLowerCase()}-${poId}.pdf`;
}

/**
 * The uploaded bank statement (M13).
 *
 * Kept because it IS the proof: a STATEMENT settlement carries no proof file of
 * its own, so the original workbook is the only artefact an auditor can be shown.
 * Deriving the key from the import id (not the uploaded filename) means two
 * admins uploading `statement.xlsx` on the same day cannot overwrite each other.
 */
export function statementKey(importId: string, ext: string): string {
  return `buyback/statements/${importId}.${ext.replace(/[^a-z0-9]/gi, "").toLowerCase()}`;
}

/**
 * Evidence attached to a REQUEST as a whole — a settlement payment proof, a
 * BWM 2022 e-way bill / weighbridge slip, a vendor's own PO PDF, or a dealer's
 * own invoice PDF (U1). `uploadKeyFor` (upload.ts) is LINE-scoped and
 * deliberately not reused here: none of these documents belong to one battery
 * line, and forcing one in would either need a fake line id or nest the
 * evidence under an arbitrary line's own prefix.
 */
export function evidenceKeyFor(requestId: string, kind: string, contentType: string): string {
  return `buyback/${requestId}/evidence/${kind}-${crypto.randomUUID()}${extensionFor(contentType)}`;
}
