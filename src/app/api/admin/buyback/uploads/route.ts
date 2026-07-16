/**
 * POST /api/admin/buyback/uploads — same-origin upload for ADMIN-side buyback
 * evidence (U1).
 *
 * Before this route existed, the only way to attach a settlement payment
 * proof was for the admin to paste a raw S3 key into a text box — there was
 * no upload endpoint anywhere in buyback for iTarang staff, only the dealer
 * one. This mirrors /api/buyback/uploads (see that file's header for why the
 * upload is a same-origin multipart POST rather than a presigned PUT: the
 * bucket has no CORS rule and the app's IAM user cannot add one), but for the
 * documents an ADMIN captures instead of the dealer:
 *
 *   · settlement_proof   — the payment proof on a settlement leg (M13)
 *   · eway_bill           — BWM 2022 chain-of-custody, captured at pickup
 *   · weighbridge_slip    — BWM 2022 chain-of-custody, captured at pickup
 *   · vendor_po           — the vendor's own PO PDF, recorded by an admin (M11)
 *
 * Validation is the same shared rule set as the dealer route
 * (src/lib/buyback/upload.ts) — each kind declares exactly which content
 * types it accepts.
 *
 * AuthN/Z: buyback admin only (requireBuybackAdmin). The `request_id` must
 * name a request that exists (loadAnyRequest) — unlike the dealer route,
 * there is no "own line" join here: an admin may attach evidence to any deal
 * they can see, not just one dealer's own.
 */

import { Readable } from "node:stream";

import { z } from "zod";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { loadAnyRequest, requireBuybackAdmin } from "@/lib/buyback/auth";
import { ValidationError } from "@/lib/buyback/errors";
import { BUYBACK_BUCKET, evidenceKeyFor } from "@/lib/buyback/storage";
import { assertS3Configured, assertUploadContentType } from "@/lib/buyback/upload";
import { putObjectStream } from "@/lib/storage/s3";

export const runtime = "nodejs";

// A phone photo of a slip is 3–10 MB; a scanned PO less. 25 MB matches the
// dealer route's cap — no reason for the two sides to disagree on this.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const fieldsSchema = z.object({
  request_id: z.string().uuid(),
  kind: z.enum(["settlement_proof", "eway_bill", "weighbridge_slip", "vendor_po"]),
});

export const POST = withErrorHandler(async (req: Request) => {
  await requireBuybackAdmin();

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    throw new ValidationError("No file in the upload.");
  }

  const { request_id, kind } = fieldsSchema.parse({
    request_id: form.get("request_id"),
    kind: form.get("kind"),
  });

  assertUploadContentType(kind, file.type);

  if (file.size > MAX_UPLOAD_BYTES) {
    throw new ValidationError(
      `The file is too large (${Math.round(file.size / 1024 / 1024)} MB). Maximum is 25 MB.`,
    );
  }

  // The request must actually exist — an admin cannot mint evidence against a
  // made-up id. 404s (via loadAnyRequest) rather than accepting anything.
  const request = await loadAnyRequest(request_id);

  assertS3Configured();

  const key = evidenceKeyFor(request.id, kind, file.type);

  // Stream straight through to S3 — see putObjectStream's doc comment for why
  // this is not `Buffer.from(await file.arrayBuffer())`. 25MB cap is already
  // enforced above, BEFORE any bytes are streamed.
  await putObjectStream(
    BUYBACK_BUCKET,
    key,
    Readable.fromWeb(
      file.stream() as unknown as import("node:stream/web").ReadableStream<Uint8Array>,
    ),
    file.type,
  );

  // Same response shape as the dealer route — the EvidenceUpload widget posts
  // to either endpoint and reads `s3_key` back either way.
  return successResponse({ s3_key: key, kind });
});
