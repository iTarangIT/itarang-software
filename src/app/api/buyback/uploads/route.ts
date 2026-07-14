/**
 * POST /api/buyback/uploads — same-origin upload for buyback evidence.
 *
 * The intake was built on presigned PUTs (/api/buyback/photos/presign), but a
 * browser PUT to S3 is cross-origin and the bucket carries no CORS
 * configuration — the preflight dies with a bare "Failed to fetch" before the
 * request ever reaches AWS, and the app's IAM user is not allowed to add a
 * CORS rule (s3:PutBucketCORS denied). So the bytes come here instead: a
 * same-origin multipart POST that the server writes to S3 itself with
 * putObject(). No bucket CORS involved.
 *
 * Validation, ownership and key derivation are the exact rules the presign
 * route applies — shared via src/lib/buyback/upload.ts. If bucket CORS is ever
 * configured, the client can switch back to the presign path without touching
 * either route.
 *
 * AuthN/Z: dealer only, and the line must belong to the caller's own request.
 */

import { z } from "zod";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireDealer } from "@/lib/buyback/auth";
import { ValidationError } from "@/lib/buyback/errors";
import { BUYBACK_BUCKET } from "@/lib/buyback/storage";
import {
  assertS3Configured,
  assertUploadContentType,
  requireOwnLine,
  uploadKeyFor,
} from "@/lib/buyback/upload";
import { putObject } from "@/lib/storage/s3";

export const runtime = "nodejs";

// A phone photo is 3–10 MB; a scanned ID is less. 25 MB leaves headroom for
// HEIC originals without letting someone stream a video through this route.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const fieldsSchema = z.object({
  line_id: z.string().uuid(),
  kind: z.enum(["photo", "id_proof", "purchase_proof"]).default("photo"),
});

export const POST = withErrorHandler(async (req: Request) => {
  const actor = await requireDealer();

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    throw new ValidationError("No file in the upload.");
  }

  const { line_id, kind } = fieldsSchema.parse({
    line_id: form.get("line_id"),
    kind: form.get("kind") ?? undefined,
  });

  assertUploadContentType(kind, file.type);

  if (file.size > MAX_UPLOAD_BYTES) {
    throw new ValidationError(
      `The file is too large (${Math.round(file.size / 1024 / 1024)} MB). Maximum is 25 MB.`,
    );
  }

  const line = await requireOwnLine(actor.entityId!, line_id);

  assertS3Configured();

  const key = uploadKeyFor(line.request_id, line.line_id, kind, file.type);
  await putObject(BUYBACK_BUCKET, key, Buffer.from(await file.arrayBuffer()), file.type);

  // The client posts `s3_key` back with the line (photos record route) or the
  // provenance record — same contract as the presign path.
  return successResponse({ s3_key: key, kind });
});
