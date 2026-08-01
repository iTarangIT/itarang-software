/**
 * Shared upload rules for buyback evidence — battery photos, ID proofs,
 * purchase receipts.
 *
 * Two routes accept these uploads: the presigned-PUT signer
 * (/api/buyback/photos/presign, the BRD M02 direct-to-S3 path) and the
 * same-origin proxy (/api/buyback/uploads, which the intake uses while the
 * bucket has no CORS rule for browser PUTs). Both MUST validate identically —
 * otherwise the effective rules become whichever route the client happens to
 * call. This module is that single source.
 */

import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { buybackBatches, buybackLines, buybackRequests } from "@/lib/db/schema";
import { NotFoundError, ValidationError } from "@/lib/buyback/errors";

export type UploadKind =
  | "photo"
  | "id_proof"
  | "purchase_proof"
  // --- U1 evidence kinds — attached to a REQUEST, not a battery line: a
  // settlement payment proof, the BWM 2022 e-way bill / weighbridge slip, a
  // vendor's own PO PDF, and a dealer's own invoice PDF. -------------------
  | "settlement_proof"
  | "eway_bill"
  | "weighbridge_slip"
  | "vendor_po"
  | "invoice_pdf"
  // --- E-223 vendor onboarding documents — attached to a VENDOR, and in fact
  // to no entity at all at upload time (see vendorDocKeyFor). Uppercase
  // because these values are also the `doc_type` written to
  // scrap_vendor_documents, and one spelling beats a mapping. ---------------
  | "GSTIN"
  | "PAN"
  | "UDYAM"
  | "AGREEMENT";

// An unconstrained content type would let these endpoints accept anything the
// dealer liked, so each kind declares exactly what it accepts.
//
// A battery PHOTO must be an image — a PDF cannot be perceptually hashed, so a
// PDF "photo" would silently opt that battery out of the duplicate-detection
// that M03 exists for. A PROOF is a document: an ID card or a receipt is very
// often a scan, and rejecting PDFs there would just push dealers into
// photographing their screens.
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic"];

export const ALLOWED_UPLOAD_TYPES: Record<UploadKind, string[]> = {
  photo: IMAGE_TYPES,
  id_proof: [...IMAGE_TYPES, "application/pdf"],
  purchase_proof: [...IMAGE_TYPES, "application/pdf"],
  // Same rule as the proofs above — a receipt, bill or PO is very often a scan.
  settlement_proof: [...IMAGE_TYPES, "application/pdf"],
  eway_bill: [...IMAGE_TYPES, "application/pdf"],
  weighbridge_slip: [...IMAGE_TYPES, "application/pdf"],
  vendor_po: [...IMAGE_TYPES, "application/pdf"],
  invoice_pdf: [...IMAGE_TYPES, "application/pdf"],
  // Statutory certificates. A vendor emails a PDF or photographs the paper —
  // both are the document, so both are accepted.
  GSTIN: [...IMAGE_TYPES, "application/pdf"],
  PAN: [...IMAGE_TYPES, "application/pdf"],
  UDYAM: [...IMAGE_TYPES, "application/pdf"],
  AGREEMENT: [...IMAGE_TYPES, "application/pdf"],
};

export function assertUploadContentType(kind: UploadKind, contentType: string): void {
  if (!ALLOWED_UPLOAD_TYPES[kind].includes(contentType)) {
    throw new ValidationError(
      kind === "photo"
        ? `A battery photo must be an image, not "${contentType}". Use JPEG, PNG, WebP or HEIC.`
        : `Unsupported file type "${contentType}". Use an image or a PDF.`,
    );
  }
}

export function extensionFor(contentType: string): string {
  switch (contentType) {
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    case "image/heic":
      return ".heic";
    case "application/pdf":
      return ".pdf";
    default:
      return ".jpg";
  }
}

/**
 * The line must hang off a request the calling dealer owns. Without this join
 * the key would be attacker-chosen and one dealer could scribble into
 * another's evidence prefix.
 */
export async function requireOwnLine(
  entityId: string,
  lineId: string,
): Promise<{ line_id: string; request_id: string }> {
  const [line] = await db
    .select({
      line_id: buybackLines.id,
      request_id: buybackRequests.id,
    })
    .from(buybackLines)
    .innerJoin(buybackBatches, eq(buybackLines.batch_id, buybackBatches.id))
    .innerJoin(buybackRequests, eq(buybackBatches.request_id, buybackRequests.id))
    .where(and(eq(buybackLines.id, lineId), eq(buybackRequests.dealer_entity_id, entityId)))
    .limit(1);

  if (!line) throw new NotFoundError("Battery line not found.");
  return line;
}

/**
 * Key is server-derived. crypto.randomUUID keeps two files for the same line
 * from overwriting each other. Proofs live under their own prefix so a photo
 * sweep never mistakes an ID card for a battery.
 */
export function uploadKeyFor(
  requestId: string,
  lineId: string,
  kind: UploadKind,
  contentType: string,
): string {
  const prefix =
    kind === "photo"
      ? `buyback/${requestId}/${lineId}`
      : `buyback/${requestId}/${lineId}/proofs`;
  return `${prefix}/${crypto.randomUUID()}${extensionFor(contentType)}`;
}

/**
 * Fail with the REASON, not a shrug: a missing bucket name and an expired
 * secret key are completely different problems with completely different
 * fixes, and an engineer staring at "check the S3 configuration" cannot tell
 * which one they have.
 */
export function assertS3Configured(): void {
  const missing = [
    !process.env.AWS_S3_BUCKET && "AWS_S3_BUCKET",
    !process.env.AWS_ACCESS_KEY_ID && "AWS_ACCESS_KEY_ID",
    !process.env.AWS_SECRET_ACCESS_KEY && "AWS_SECRET_ACCESS_KEY",
    !process.env.AWS_REGION && "AWS_REGION",
    (process.env.STORAGE_BACKEND || "").toLowerCase() !== "s3" && "STORAGE_BACKEND=s3",
  ].filter(Boolean);

  if (missing.length > 0) {
    throw new ValidationError(
      `Photo upload is not configured on this server. Missing: ${missing.join(", ")}. ` +
        `Set these in .env.local and restart the server.`,
      { code: "S3_NOT_CONFIGURED", missing },
    );
  }
}
