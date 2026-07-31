/**
 * POST /api/admin/buyback/vendors/uploads — attach a document to a scrap
 * vendor that does not exist yet (E-222).
 *
 * THE PROBLEM THIS SOLVES. Every other buyback upload derives its key from a
 * request the caller already owns (evidenceKeyFor, uploadKeyFor). Vendor
 * onboarding has no such anchor: the admin picks the GST certificate, the PAN
 * card and the Udyam certificate BEFORE submitting the form that creates the
 * vendor, so at upload time there is no accounts.id to scope anything to.
 *
 * THE SHAPE. This route streams the bytes to a server-derived staging key and
 * inserts an UNCLAIMED scrap_vendor_documents row (entity_id NULL), then hands
 * back that row's id. The form submits document IDs, never keys, and POST
 * /api/admin/buyback/vendors claims them by setting entity_id + claimed_at.
 *
 * The rejected alternative was to return the S3 key and let the create route
 * store whatever key came back. That would make an admin-supplied string a
 * storage path — the exact thing src/lib/buyback/storage.ts refuses ("keys are
 * always SERVER-DERIVED") — and a typo'd or hostile key would silently point a
 * vendor's compliance record at another dealer's file. A uuid the server minted
 * cannot address anything it did not create.
 *
 * Validation reuses the shared rule set (src/lib/buyback/upload.ts), so this
 * route and the two evidence routes cannot drift on what a document may be.
 *
 * AuthN/Z: buyback admin only. An abandoned form leaves an unclaimed row, which
 * is identifiable (entity_id IS NULL, indexed by E-222) rather than an
 * untracked object in the bucket.
 */

import { Readable } from "node:stream";

import { z } from "zod";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { scrapVendorDocuments } from "@/lib/db/schema";
import { requireBuybackAdmin } from "@/lib/buyback/auth";
import { ValidationError } from "@/lib/buyback/errors";
import { BUYBACK_BUCKET, vendorDocKeyFor } from "@/lib/buyback/storage";
import { assertS3Configured, assertUploadContentType } from "@/lib/buyback/upload";
import { VENDOR_DOC_TYPES } from "@/lib/buyback/vendor-docs";
import { putObjectStream } from "@/lib/storage/s3";

export const runtime = "nodejs";

// A GST certificate is a 1-2 page PDF; a phone photo of a Udyam printout is
// the large case. Lower than the 25 MB evidence cap because none of these is a
// battery photo set, and a 25 MB "certificate" is a scanner misconfigured.
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

const fieldsSchema = z.object({
  kind: z.enum(VENDOR_DOC_TYPES),
});

export const POST = withErrorHandler(async (req: Request) => {
  const actor = await requireBuybackAdmin();

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    throw new ValidationError("No file in the upload.");
  }

  const { kind } = fieldsSchema.parse({ kind: form.get("kind") });

  assertUploadContentType(kind, file.type);

  if (file.size > MAX_UPLOAD_BYTES) {
    throw new ValidationError(
      `The file is too large (${Math.round(file.size / 1024 / 1024)} MB). Maximum is 15 MB.`,
    );
  }

  assertS3Configured();

  const key = vendorDocKeyFor(kind, file.type);

  // Stream straight through to S3 — see putObjectStream's doc comment for why
  // this is not `Buffer.from(await file.arrayBuffer())`. The size cap is
  // enforced above, BEFORE any bytes are streamed.
  await putObjectStream(
    BUYBACK_BUCKET,
    key,
    Readable.fromWeb(
      file.stream() as unknown as import("node:stream/web").ReadableStream<Uint8Array>,
    ),
    file.type,
  );

  // The row is written only after the bytes land: a document row pointing at a
  // key that does not exist would be claimable, and the vendor's compliance
  // record would show a certificate nobody can open.
  const [row] = await db
    .insert(scrapVendorDocuments)
    .values({
      entity_id: null,
      doc_type: kind,
      s3_key: key,
      file_name: file.name,
      content_type: file.type,
      uploaded_by: actor.id,
    })
    .returning({ id: scrapVendorDocuments.id });

  if (!row) throw new ValidationError("The document could not be recorded.");

  return successResponse({ document_id: row.id, kind, file_name: file.name });
});
