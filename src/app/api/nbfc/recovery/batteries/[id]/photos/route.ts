/**
 * E-232 — POST /api/nbfc/recovery/batteries/[id]/photos (Battery Auction §20)
 *
 * Same-origin multipart upload for battery photos: front, back, side, serial
 * plate and damage. Captured ONCE here and reused verbatim as the auction
 * images — nothing re-uploads them at lot composition.
 *
 * PRESIGNED PUT IS NOT AN OPTION. The bucket carries no CORS configuration and
 * the app's IAM user cannot add one (`s3:PutBucketCORS` denied), so a browser
 * PUT dies in preflight with a bare "Failed to fetch" before it reaches AWS.
 * The bytes come here and the server writes them. Same reasoning, same shape,
 * as /api/buyback/uploads.
 *
 * The `documents` bucket is reused rather than a new one being added to
 * ALLOWED_BUCKETS in the files proxy: battery photos are authenticated content,
 * `documents` is already the auth-required bucket, and an `auction/batteries/`
 * key prefix keeps them findable. The public auction page (Phase 6) is the only
 * thing that would need an anonymous bucket, and it is out of scope.
 */
import { Readable } from "node:stream";
import { NextRequest, NextResponse } from "next/server";
import { clientError } from "@/lib/nbfc/http-error";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { attachBatteryPhotos, getBattery } from "@/lib/nbfc/recovery/battery";
import { filesProxyPath, putObjectStream, isS3Backend } from "@/lib/storage/s3";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BUCKET = "documents";

// A phone photo is 3–10 MB. 25 MB leaves headroom for HEIC originals without
// letting someone stream a video through this route. Same cap as buyback.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

// Battery photos only. No PDFs — this is not a document route, and accepting
// one would put a file the auction gallery cannot render into image_urls.
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
    const { id: batteryId } = await ctx.params;

    // Ownership first — before reading a single byte of the body. Checking
    // afterwards would mean buffering an upload from someone with no claim to
    // the battery, then throwing it away.
    const battery = await getBattery(actor.tenant_id, batteryId);
    if (!battery) {
      return NextResponse.json(
        { ok: false, error: "NOT_FOUND: battery not found" },
        { status: 404 },
      );
    }

    // Refuse an oversized body BEFORE parsing it. `req.formData()` buffers the
    // ENTIRE request into heap, so a file.size check alone protects the S3 bill
    // and not this process — and sandbox and production are co-resident on one
    // 8 GB VPS. Content-Length is a hint (chunked uploads omit it, a liar can
    // understate it), so this is an early gate and file.size below is still the
    // real guard.
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
            "CONFLICT: STORAGE_BACKEND is not 's3'; battery photo upload needs the S3 backend",
        },
        { status: 409 },
      );
    }

    const form = await req.formData();
    // Accept several files in one request — an operator shoots the whole set at
    // once, and five sequential requests is five chances for a partial upload.
    const files = form.getAll("file").filter((f): f is File => f instanceof File);
    if (files.length === 0) {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: no file in the upload" },
        { status: 400 },
      );
    }

    const label = String(form.get("label") ?? "photo")
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "")
      .slice(0, 24) || "photo";

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

      // Key carries the battery id and a monotonic suffix, so a retried upload
      // of the same shot does not collide with the first attempt and the
      // dedupe in attachBatteryPhotos has something stable to work on.
      const ext = EXTENSION[file.type] ?? "bin";
      const key = `auction/batteries/${batteryId}/${label}-${Date.now()}-${i}.${ext}`;

      await putObjectStream(
        BUCKET,
        key,
        Readable.fromWeb(
          file.stream() as unknown as import("node:stream/web").ReadableStream<Uint8Array>,
        ),
        file.type,
      );

      // Store the RELATIVE proxy path, never an absolute URL — the backend
      // flips between Supabase and S3 behind STORAGE_BACKEND and the proxy
      // route is the only stable address.
      paths.push(filesProxyPath(BUCKET, key));
    }

    const updated = await attachBatteryPhotos(actor.tenant_id, batteryId, paths);

    return NextResponse.json({
      ok: true,
      uploaded: paths.length,
      image_urls: updated.image_urls,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: clientError(msg) },
      { status: statusFromError(msg) },
    );
  }
}
