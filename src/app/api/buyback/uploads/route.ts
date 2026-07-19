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

import { Readable } from "node:stream";

import { z } from "zod";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { loadOwnRequest, requireDealer } from "@/lib/buyback/auth";
import { ValidationError } from "@/lib/buyback/errors";
import { BUYBACK_BUCKET, evidenceKeyFor } from "@/lib/buyback/storage";
import {
  assertS3Configured,
  assertUploadContentType,
  requireOwnLine,
  uploadKeyFor,
} from "@/lib/buyback/upload";
import { putObjectStream } from "@/lib/storage/s3";

export const runtime = "nodejs";

// A phone photo is 3–10 MB; a scanned ID is less. 25 MB leaves headroom for
// HEIC originals without letting someone stream a video through this route.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

// invoice_pdf (U1) is REQUEST-scoped, not line-scoped — an invoice covers the
// whole deal, not one battery — so it takes request_id instead of line_id.
// Every other kind keeps taking line_id, unchanged.
const fieldsSchema = z
  .object({
    line_id: z.string().uuid().optional(),
    request_id: z.string().uuid().optional(),
    kind: z.enum(["photo", "id_proof", "purchase_proof", "invoice_pdf"]).default("photo"),
  })
  .refine(
    (v) =>
      v.kind === "invoice_pdf"
        ? Boolean(v.request_id) && !v.line_id
        : Boolean(v.line_id) && !v.request_id,
    {
      message:
        "invoice_pdf uploads take request_id (no line_id); every other kind takes line_id (no request_id).",
    },
  );

export const POST = withErrorHandler(async (req: Request) => {
  const actor = await requireDealer();

  // Refuse an oversized body BEFORE parsing it.
  //
  // `req.formData()` below buffers the ENTIRE request into heap. The file.size
  // check further down runs after that — so it has never protected this process,
  // only the S3 bill. A single large POST could OOM the node before any check
  // ran, and sandbox and production are co-resident on one 8GB VPS.
  //
  // Content-Length is a HINT, not a guarantee: a chunked upload omits it, and a
  // liar can understate it. So this is a cheap early gate, not the guard — the
  // real one is still file.size below, and the residual exposure is a chunked
  // or under-declared body. Closing that properly needs streaming multipart
  // parsing, which Request.formData() does not do; that is a bigger change than
  // this bug is worth today, but it is why this comment does not claim victory.
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
    throw new ValidationError(
      `The file is too large (${Math.round(declared / 1024 / 1024)} MB). Maximum is ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB.`,
    );
  }

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    throw new ValidationError("No file in the upload.");
  }

  const { line_id, request_id, kind } = fieldsSchema.parse({
    line_id: form.get("line_id") ?? undefined,
    request_id: form.get("request_id") ?? undefined,
    kind: form.get("kind") ?? undefined,
  });

  assertUploadContentType(kind, file.type);

  if (file.size > MAX_UPLOAD_BYTES) {
    throw new ValidationError(
      `The file is too large (${Math.round(file.size / 1024 / 1024)} MB). Maximum is 25 MB.`,
    );
  }

  assertS3Configured();

  // Ownership + key derivation branch on scope: invoice_pdf hangs off the
  // request (loadOwnRequest), every other kind off one of the dealer's own
  // lines (requireOwnLine) — exactly as before this kind existed.
  let key: string;
  if (kind === "invoice_pdf") {
    const request = await loadOwnRequest(actor, request_id!);
    key = evidenceKeyFor(request.id, "invoice_pdf", file.type);
  } else {
    const line = await requireOwnLine(actor.entityId!, line_id!);
    key = uploadKeyFor(line.request_id, line.line_id, kind, file.type);
  }

  // Hand the body to S3 as a stream rather than a second in-memory copy — see
  // putObjectStream's doc comment.
  //
  // This used to claim the file was never buffered into memory and that the cap
  // was "enforced above, before any bytes are streamed". Both were false:
  // req.formData() has already buffered the whole request by the time execution
  // reaches this line, and the size check ran after it. The Content-Length gate
  // at the top of this handler is what now refuses an oversized body early; this
  // call only avoids making it worse.
  await putObjectStream(
    BUYBACK_BUCKET,
    key,
    Readable.fromWeb(
      file.stream() as unknown as import("node:stream/web").ReadableStream<Uint8Array>,
    ),
    file.type,
  );

  // The client posts `s3_key` back with the line (photos record route), the
  // provenance record, or the invoice — same contract as the presign path.
  return successResponse({ s3_key: key, kind });
});
