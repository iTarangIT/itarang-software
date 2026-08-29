/**
 * E-258 — POST /api/nbfc/scrap/consignments/[id]/photos
 *
 * Consignment-level photographs: the pile as it sits, the weighbridge slip, the
 * gate. Per-battery shots are NOT uploaded here — those live on the battery
 * itself (`POST /api/nbfc/recovery/batteries/[id]/photos`) and this screen
 * renders them from there, so one battery photographed once is visible in every
 * consignment it ever appears in.
 *
 * Same-origin multipart, not a presigned PUT: the bucket carries no CORS rules
 * and the app's IAM user cannot add one, so a browser PUT dies in preflight
 * with a bare "Failed to fetch". The bytes come here and the server writes
 * them — identical reasoning, and identical guards, to the battery photo route.
 */
import { Readable } from "node:stream";
import { NextRequest, NextResponse } from "next/server";
import { clientError } from "@/lib/nbfc/http-error";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import {
  attachConsignmentPhotos,
  getConsignment,
  CLOSED_STATUSES,
} from "@/lib/nbfc/scrap/consignment";
import { filesProxyPath, putObjectStream, isS3Backend } from "@/lib/storage/s3";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BUCKET = "documents";
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);

const EXTENSION: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
};

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("CONFLICT")) return 409;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const actor = await resolveActor(req.headers);
    const { id } = await ctx.params;

    // Ownership first — before a single byte of the body is read. Checking
    // afterwards would mean buffering an upload from someone with no claim to
    // the consignment and then throwing it away.
    const consignment = await getConsignment(id, actor.tenant_id);
    if (!consignment) {
      return NextResponse.json(
        { ok: false, error: "NOT_FOUND: consignment not found" },
        { status: 404 },
      );
    }
    if (CLOSED_STATUSES.includes(consignment.status)) {
      return NextResponse.json(
        {
          ok: false,
          error: `CONFLICT: consignment is ${consignment.status} — its photographs are now part of a closed record`,
        },
        { status: 409 },
      );
    }

    // Refuse an oversized body BEFORE parsing it: req.formData() buffers the
    // ENTIRE request into heap, and sandbox and production are co-resident on
    // one 8 GB VPS. Content-Length is a hint, so file.size below is the real
    // guard.
    const declared = Number(req.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        {
          ok: false,
          error: `BAD_REQUEST: upload is too large (${Math.round(declared / 1024 / 1024)} MB); maximum is 25 MB`,
        },
        { status: 413 },
      );
    }

    if (!isS3Backend) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "CONFLICT: STORAGE_BACKEND is not 's3'; photo upload needs the S3 backend",
        },
        { status: 409 },
      );
    }

    const form = await req.formData();
    const files = form.getAll("file").filter((f): f is File => f instanceof File);
    if (files.length === 0) {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: no file in the upload" },
        { status: 400 },
      );
    }

    const label =
      String(form.get("label") ?? "lot")
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, "")
        .slice(0, 24) || "lot";

    const paths: string[] = [];
    for (const [i, file] of files.entries()) {
      if (!ALLOWED_TYPES.has(file.type)) {
        return NextResponse.json(
          {
            ok: false,
            error: `BAD_REQUEST: ${file.type || "unknown type"} is not an accepted image type`,
          },
          { status: 400 },
        );
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        return NextResponse.json(
          {
            ok: false,
            error: `BAD_REQUEST: ${file.name} is too large (${Math.round(file.size / 1024 / 1024)} MB); maximum is 25 MB`,
          },
          { status: 413 },
        );
      }

      const ext = EXTENSION[file.type] ?? "bin";
      const key = `scrap/consignments/${id}/${label}-${Date.now()}-${i}.${ext}`;

      await putObjectStream(
        BUCKET,
        key,
        Readable.fromWeb(
          file.stream() as unknown as import("node:stream/web").ReadableStream<Uint8Array>,
        ),
        file.type,
      );

      // RELATIVE proxy path, never an absolute URL: the backend flips between
      // Supabase and S3 behind STORAGE_BACKEND and the proxy is the only stable
      // address.
      paths.push(filesProxyPath(BUCKET, key));
    }

    const updated = await attachConsignmentPhotos(id, actor.tenant_id, paths);

    return NextResponse.json({
      ok: true,
      uploaded: paths.length,
      photo_urls: updated.photo_urls,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: clientError(e) },
      { status: statusFromError(msg) },
    );
  }
}
