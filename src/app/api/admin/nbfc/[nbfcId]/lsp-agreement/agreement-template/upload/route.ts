/**
 * E-110 — POST /api/admin/nbfc/{nbfcId}/lsp-agreement/agreement-template/upload
 *
 * Multipart helper for the Step 3 Agreement panel's template uploader.
 * Admin uploads the blank "empty fields" agreement PDF (the one Digio will
 * eventually paint with signer fields once the CEO approves).
 *
 * Constraints:
 *   - mime = application/pdf only
 *   - size ≤ 15 MB
 *
 * Writes to public/nbfc-uploads/{nbfcId}/agreement-template/ and returns
 * the public URL; no DB write here — the URL stays in client form state
 * until the Send-to-CEO POST persists it on
 * nbfc_lsp_agreements.agreement_template_url.
 */
import { NextRequest, NextResponse } from "next/server";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { requireAdminOrTestBypass } from "@/lib/auth/adminTestBypass";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 15 * 1024 * 1024;

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
      { ok: false, error: "File exceeds 15 MB" },
      { status: 413 },
    );
  }
  if (file.type !== "application/pdf") {
    return NextResponse.json(
      {
        ok: false,
        error: "Only PDF is accepted for the agreement template",
        receivedMime: file.type,
      },
      { status: 415 },
    );
  }

  const timestamp = Date.now();
  const rand = randomBytes(6).toString("hex");
  const filename = `${timestamp}-${rand}.pdf`;

  const urlDir = path.posix.join(
    "nbfc-uploads",
    String(id),
    "agreement-template",
  );
  const absDir = path.join(
    process.cwd(),
    "public",
    "nbfc-uploads",
    String(id),
    "agreement-template",
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
