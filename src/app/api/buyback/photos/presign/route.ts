/**
 * POST /api/buyback/photos/presign
 *
 * Hands the dealer's browser a short-lived presigned PUT so the photo goes
 * straight to S3 — the intake page uploads 5-6 per battery line in the
 * background while the dealer keeps typing (BRD M02/§6).
 *
 * NOTE: a browser PUT to the presigned URL is cross-origin, so this path only
 * works once the bucket has a CORS rule allowing PUT from the app origin. The
 * bucket currently has none (and the app's IAM user may not add one), so the
 * intake uploads through /api/buyback/uploads instead. Both routes share the
 * same rules via src/lib/buyback/upload.ts; this one stays for when CORS is
 * configured.
 *
 * AuthN/Z: dealer only, and the line must belong to the caller's own request.
 * Without that join the key would be attacker-chosen and one dealer could
 * scribble into another's photo prefix.
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
import { signUpload } from "@/lib/storage/s3";

export const runtime = "nodejs";

const bodySchema = z.object({
  line_id: z.string().uuid(),
  unit_id: z.string().uuid().nullish(),
  content_type: z.string(),
  /** What is being uploaded. Decides both the allowed types and the key prefix. */
  kind: z.enum(["photo", "id_proof", "purchase_proof"]).default("photo"),
  /** Only used to pick a sane extension; never trusted as a path. */
  file_name: z.string().max(255).optional(),
});

export const POST = withErrorHandler(async (req: Request) => {
  const actor = await requireDealer();
  const body = bodySchema.parse(await req.json());

  assertUploadContentType(body.kind, body.content_type);

  const line = await requireOwnLine(actor.entityId!, body.line_id);

  const key = uploadKeyFor(line.request_id, line.line_id, body.kind, body.content_type);

  assertS3Configured();

  const url = await signUpload(BUYBACK_BUCKET, key, body.content_type);
  if (!url) {
    // Env is present but AWS still refused to sign — bad credentials, a bucket in
    // another region, or a clock skew. The server log carries the AWS error.
    throw new ValidationError(
      "The storage service rejected the upload request. The AWS credentials or the " +
        "bucket region may be wrong — check the server logs for the AWS error.",
      { code: "S3_SIGN_FAILED", bucket: process.env.AWS_S3_BUCKET, region: process.env.AWS_REGION },
    );
  }

  // The client PUTs the bytes to `url`, then posts `s3_key` back with the line.
  return successResponse({ url, s3_key: key, bucket: BUYBACK_BUCKET, expires_in: 300, kind: body.kind });
});
