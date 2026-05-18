/**
 * E-107 — POST /api/admin/nbfc/{nbfcId}/compliance-documents/upload
 *
 * Multipart file upload helper for the Step 2 Documents panel. Writes the
 * uploaded file under public/nbfc-uploads/{nbfcId}/{timestamp}-{slug}.{ext}
 * so Next serves it back at /nbfc-uploads/{nbfcId}/... — returns that URL
 * so the caller can immediately POST it to the JSON compliance-documents
 * endpoint with `fileUrl` set.
 *
 * Body (multipart/form-data):
 *   documentType  text (matches the JSON route's DOCUMENT_TYPES enum)
 *   file          file
 *
 * This is a pragmatic local-disk implementation. A production S3 swap-in
 * replaces only the write-to-disk block; the calling pattern stays.
 */
import { NextRequest, NextResponse } from "next/server";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { requireAdminOrTestBypass } from "@/lib/auth/adminTestBypass";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 15 * 1024 * 1024; // 15 MB
const SAFE_EXT_RE = /^[a-z0-9]{1,8}$/i;

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ nbfcId: string }> },
) {
  const auth = await requireAdminOrTestBypass(req.headers);
  if (!auth.ok) return auth.response;

  const { nbfcId } = await ctx.params;
  const id = Number.parseInt(nbfcId, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json(
      { ok: false, error: "Invalid nbfcId" },
      { status: 400 },
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Expected multipart/form-data body" },
      { status: 400 },
    );
  }

  const documentType = String(form.get("documentType") ?? "").trim();
  const file = form.get("file");
  if (!documentType) {
    return NextResponse.json(
      { ok: false, error: "documentType is required" },
      { status: 422 },
    );
  }
  if (!(file instanceof File)) {
    return NextResponse.json(
      { ok: false, error: "file field is required" },
      { status: 422 },
    );
  }
  if (file.size === 0) {
    return NextResponse.json(
      { ok: false, error: "Empty file" },
      { status: 422 },
    );
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { ok: false, error: `File exceeds ${MAX_BYTES} bytes` },
      { status: 413 },
    );
  }

  const rawName = file.name || "upload";
  const lastDot = rawName.lastIndexOf(".");
  const extCandidate =
    lastDot >= 0 ? rawName.slice(lastDot + 1).toLowerCase() : "";
  const ext = SAFE_EXT_RE.test(extCandidate) ? extCandidate : "bin";

  const slugSafe = documentType.replace(/[^a-z0-9_-]/gi, "_");
  const timestamp = Date.now();
  const filename = `${timestamp}-${slugSafe}.${ext}`;

  // Disk I/O uses platform-native `path.join`; URL building uses
  // `path.posix.join` so the response always has forward slashes. Mixing
  // the two (Windows backslashes leaking into the URL) was rejected
  // downstream as a non-conforming `fileUrl` by the JSON route's regex.
  const urlDir = path.posix.join("nbfc-uploads", String(id));
  const absDir = path.join(process.cwd(), "public", "nbfc-uploads", String(id));
  const absPath = path.join(absDir, filename);

  await mkdir(absDir, { recursive: true });
  const buf = Buffer.from(await file.arrayBuffer());
  await writeFile(absPath, buf);

  // Next serves anything in public/ from the site root, so this URL is
  // immediately fetchable.
  const fileUrl = `/${path.posix.join(urlDir, filename)}`;

  return NextResponse.json({
    ok: true,
    fileUrl,
    size: file.size,
  });
}
