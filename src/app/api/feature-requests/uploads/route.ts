/**
 * POST /api/feature-requests/uploads — upload ONE attachment (multipart `file`).
 *
 * The file is stored and recorded unclaimed (feature_request_id NULL); the
 * create / comment / attach call then claims it by id. One file per request
 * keeps each body under the cap and lets the UI show per-file progress and
 * errors. Same-origin through the server because the bucket has no CORS, so a
 * browser presigned PUT can't work (see /api/buyback/uploads).
 */
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { featureRequestAttachments } from "@/lib/db/schema";
import {
  ATTACHMENT_BUCKET,
  HttpError,
  MAX_ATTACHMENT_BYTES,
  assertAllowedFile,
  requireSeat,
  safeFileName,
} from "@/lib/feature-requests/server";
import { isS3Backend, putObjectStream } from "@/lib/storage/s3";

export const runtime = "nodejs";

export const POST = withErrorHandler(async (req: Request) => {
  const user = await requireSeat();

  // Refuse an oversized body before formData() buffers it (sandbox and prod
  // share one 8GB box). file.size below is the real check.
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_ATTACHMENT_BYTES + 64 * 1024) {
    throw new HttpError(
      `The file is too large (${Math.round(declared / 1024 / 1024)} MB). Maximum is ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`,
      413,
    );
  }
  if (!isS3Backend) throw new HttpError("File storage is not configured on this server.", 503);

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw new HttpError("No file in the upload.", 400);
  assertAllowedFile(file.name, file.size);

  const now = new Date();
  const key = `feature-requests/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${randomUUID()}-${safeFileName(file.name)}`;
  const contentType = file.type || "application/octet-stream";

  await putObjectStream(
    ATTACHMENT_BUCKET,
    key,
    Readable.fromWeb(file.stream() as unknown as import("node:stream/web").ReadableStream<Uint8Array>),
    contentType,
  );

  const [row] = await db
    .insert(featureRequestAttachments)
    .values({
      uploaded_by: user.id,
      file_name: file.name.slice(0, 255),
      mime_type: contentType.slice(0, 150),
      size_bytes: file.size,
      storage_bucket: ATTACHMENT_BUCKET,
      storage_key: key,
    })
    .returning({
      id: featureRequestAttachments.id,
      file_name: featureRequestAttachments.file_name,
      size_bytes: featureRequestAttachments.size_bytes,
      mime_type: featureRequestAttachments.mime_type,
    });

  return successResponse(row, 201);
});
