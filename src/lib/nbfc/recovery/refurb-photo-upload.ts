/**
 * E-270 — the shared body of the two lot-photo upload routes (NBFC + admin).
 *
 * Same-origin multipart written server-side, never a presigned PUT: the bucket
 * carries no CORS rules, so a browser PUT dies in preflight. Identical guards
 * to the scrap consignment photo route, on which this is modelled.
 *
 * `target` says where the pictures belong:
 *   out_dispatch | out_receipt | ret_dispatch | ret_receipt   → the lot (photos, append)
 *   out_eway_bill | ret_eway_bill                              → the lot (one document, replaces; PDF allowed)
 *   item:<job_id>:out | item:<job_id>:return                   → one battery's receipt
 */
import { Readable } from "node:stream";
import { NextRequest, NextResponse } from "next/server";
import { filesProxyPath, putObjectStream, isS3Backend } from "@/lib/storage/s3";
import {
  attachItemPhotos,
  attachLotPhotos,
  getLot,
  type PhotoTarget,
} from "@/lib/nbfc/recovery/refurbishment-lots";

const BUCKET = "documents";
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);
// [E-271] An e-way bill is a PDF from the GST portal far more often than a photo.
const DOC_TYPES = new Set([...ALLOWED_TYPES, "application/pdf"]);
const EXTENSION: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "application/pdf": "pdf",
};
const LOT_TARGETS: PhotoTarget[] = ["out_dispatch", "out_receipt", "ret_dispatch", "ret_receipt", "out_eway_bill", "ret_eway_bill"];
const DOC_TARGETS = new Set<string>(["out_eway_bill", "ret_eway_bill"]);

export async function handleLotPhotoUpload(
  req: NextRequest,
  lotId: string,
  tenantId: string | null,
): Promise<NextResponse> {
  // Ownership first — before a byte of the body is read.
  const lot = await getLot(lotId, tenantId);
  if (!lot) return NextResponse.json({ ok: false, error: "NOT_FOUND: lot not found" }, { status: 404 });
  if (lot.status === "settled" || lot.status === "cancelled") {
    return NextResponse.json(
      { ok: false, error: `CONFLICT: lot is ${lot.status} — its photographs are part of a closed record` },
      { status: 409 },
    );
  }

  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      { ok: false, error: `BAD_REQUEST: upload is too large (${Math.round(declared / 1024 / 1024)} MB); maximum is 25 MB` },
      { status: 413 },
    );
  }
  if (!isS3Backend) {
    return NextResponse.json(
      { ok: false, error: "CONFLICT: STORAGE_BACKEND is not 's3'; photo upload needs the S3 backend" },
      { status: 409 },
    );
  }

  const form = await req.formData();
  const files = form.getAll("file").filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    return NextResponse.json({ ok: false, error: "BAD_REQUEST: no file in the upload" }, { status: 400 });
  }
  const target = String(form.get("target") ?? "out_dispatch");
  const itemMatch = target.match(/^item:([0-9a-f-]{36}):(out|return)$/i);
  if (!itemMatch && !(LOT_TARGETS as string[]).includes(target)) {
    return NextResponse.json({ ok: false, error: `BAD_REQUEST: unknown photo target ${target}` }, { status: 400 });
  }

  const paths: string[] = [];
  for (const [i, file] of files.entries()) {
    const accepted = DOC_TARGETS.has(target) ? DOC_TYPES : ALLOWED_TYPES;
    if (!accepted.has(file.type)) {
      return NextResponse.json(
        { ok: false, error: `BAD_REQUEST: ${file.type || "unknown type"} is not an accepted ${DOC_TARGETS.has(target) ? "document" : "image"} type` },
        { status: 400 },
      );
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        { ok: false, error: `BAD_REQUEST: ${file.name} is too large; maximum is 25 MB` },
        { status: 413 },
      );
    }
    const ext = EXTENSION[file.type] ?? "bin";
    const label = target.replace(/[^a-z0-9_-]/gi, "").slice(0, 48);
    const key = `refurb/lots/${lotId}/${label}-${Date.now()}-${i}.${ext}`;
    await putObjectStream(
      BUCKET,
      key,
      Readable.fromWeb(file.stream() as unknown as import("node:stream/web").ReadableStream<Uint8Array>),
      file.type,
    );
    // RELATIVE proxy path, never an absolute URL.
    paths.push(filesProxyPath(BUCKET, key));
  }

  const photo_urls = itemMatch
    ? await attachItemPhotos(lotId, tenantId, itemMatch[1], itemMatch[2] as "out" | "return", paths)
    : await attachLotPhotos(lotId, tenantId, target as PhotoTarget, paths);

  return NextResponse.json({ ok: true, uploaded: paths.length, paths, photo_urls });
}

export function photoStatusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("CONFLICT")) return 409;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}
