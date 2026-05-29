/**
 * E-109 — POST /api/admin/nbfc/{nbfcId}/lsp-agreement/signer-identity/upload
 *
 * Multipart helper for the Step 3 Agreement signer cards. Each signer must
 * attach an identity document (PAN / Aadhaar / Passport) before the form is
 * submittable. Constraints from the spec:
 *   - mime ∈ { application/pdf, image/jpeg, image/png }
 *   - size ≤ 5 MB
 *
 * Writes the file under public/nbfc-uploads/{nbfcId}/signer-identity/ and
 * returns the public URL; the URL stays in client form state until the
 * Initiate POST persists it on nbfc_lsp_agreement_signers.identity_document_url.
 *
 * No DB write here. Auth: shared admin/test-bypass idiom from E-007/E-107.
 */
import { NextRequest, NextResponse } from "next/server";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { requireAdminOrTestBypass } from "@/lib/auth/adminTestBypass";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const ALLOWED_MIMES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
]);
const MIME_TO_EXT: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
};

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

  const file = form.get("file");
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
      { ok: false, error: "File exceeds 5 MB" },
      { status: 413 },
    );
  }
  if (!ALLOWED_MIMES.has(file.type)) {
    return NextResponse.json(
      {
        ok: false,
        error: "Only PDF, JPG, and PNG are accepted",
        receivedMime: file.type,
      },
      { status: 415 },
    );
  }

  const ext = MIME_TO_EXT[file.type] ?? "bin";
  const timestamp = Date.now();
  const rand = randomBytes(6).toString("hex");
  const filename = `${timestamp}-${rand}.${ext}`;

  const urlDir = path.posix.join("nbfc-uploads", String(id), "signer-identity");
  const absDir = path.join(
    process.cwd(),
    "public",
    "nbfc-uploads",
    String(id),
    "signer-identity",
  );
  const absPath = path.join(absDir, filename);

  await mkdir(absDir, { recursive: true });
  const buf = Buffer.from(await file.arrayBuffer());
  await writeFile(absPath, buf);

  const fileUrl = `/${path.posix.join(urlDir, filename)}`;

  return NextResponse.json({
    ok: true,
    fileUrl,
    size: file.size,
  });
}
