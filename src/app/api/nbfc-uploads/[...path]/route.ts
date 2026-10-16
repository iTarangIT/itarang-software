/**
 * GET /api/nbfc-uploads/{...path}
 *
 * Serves NBFC documents — FI visit photos, FI agent reference photos,
 * compliance docs, LSP agreement templates, signer identity docs, cached
 * signed/audit PDFs.
 *
 * Storage backend: the PRIVATE Supabase bucket `nbfc-documents` (see
 * src/lib/nbfc/nbfc-storage.ts). The DB still stores `/nbfc-uploads/<key>`
 * URLs, and this route maps `<key>` to the bucket object — so existing rows
 * and display components need no change.
 *
 * AUTH (tracker ID 166, 16 Oct): a session alone is no longer enough — the
 * same file rule as /api/files (src/lib/storage/fileRules.ts): Admin, Sales
 * Head, CEO and the owner of the lead's dealer account; an NBFC login only for
 * its own cases (field visits, video KYC, its own onboarding papers and agent
 * photos) and for applications shared with it; the lead's dealer for its own
 * customer's loan agreement. Or a signed link minted for exactly this file
 * (GET /api/files/link, 15 minutes). Every open of an identity file (field
 * visit photos, video KYC, signer ID, per-lead files) is logged.
 *
 * The local public-folder fallback is gone (ID 166 report row): a file that is
 * not in the store is "not found", like /api/files.
 */
import { NextRequest, NextResponse } from "next/server";

import { getAuthenticatedAppUser } from "@/lib/kyc/admin-workflow";
import { getNbfcObject } from "@/lib/nbfc/nbfc-storage";
import { fileLinkTooLong, fileLinkValid, safeStorageKey } from "@/lib/storage/fileAccess";
import { canOpenStoredFile, logFileOpen } from "@/lib/storage/fileAuthz";
import { classifyFile, isLoggedFile, NBFC_FILE_BUCKET } from "@/lib/storage/fileRules";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CONTENT_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  // Passive VKYC session videos (E-154) play in the Acquire review screen.
  ".webm": "video/webm",
  ".mp4": "video/mp4",
};

function extOf(key: string): string {
  const name = key.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}

function fileResponse(buf: Buffer, ext: string): NextResponse {
  const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type": contentType,
      // inline so PDFs/images render in the iframe/<img>, not download.
      "Content-Disposition": "inline",
      "Content-Length": String(buf.byteLength),
      // Cache-Control is set globally to no-store by next.config.ts headers().
    },
  });
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> },
) {
  const { path: segments } = await ctx.params;
  if (!segments || segments.length === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // The same path check as /api/files: no `..` in any encoding, no slash or
  // control character inside a segment (the old check refused a plain ".."
  // only).
  const key = safeStorageKey(segments);
  if (!key) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  const bucket = NBFC_FILE_BUCKET;
  const file = classifyFile(bucket, key);
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
  const exp = req.nextUrl.searchParams.get("exp");
  const by = req.nextUrl.searchParams.get("by") || null;
  // A signed link for exactly this file, never honoured for more than 15
  // minutes on an identity file whatever minted it.
  const signedLink =
    fileLinkValid(bucket, key, exp, req.nextUrl.searchParams.get("sig"), Date.now(), by) &&
    !(isLoggedFile(file) && fileLinkTooLong(exp));

  if (signedLink) {
    await logFileOpen({ file, bucket, key, userId: by, role: null, via: "signed_link", allowed: true, ip });
  } else {
    let user: Awaited<ReturnType<typeof getAuthenticatedAppUser>> = null;
    try {
      user = await getAuthenticatedAppUser();
    } catch {
      user = null;
    }
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { allowed } = await canOpenStoredFile(user, bucket, key);
    await logFileOpen({ file, bucket, key, userId: user.id, role: user.role, via: "session", allowed, ip });
    if (!allowed) return forbidden(req);
  }

  const buf = await getNbfcObject(key);
  if (!buf) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return fileResponse(buf, extOf(key));
}

/** 403 for a signed-in user this file is not for (ID 166). */
function forbidden(req: NextRequest) {
  if (!(req.headers.get("accept") || "").includes("text/html")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return new NextResponse(
    `<!doctype html><meta charset="utf-8"><title>Not available</title>` +
      `<div style="font:15px/1.6 system-ui,sans-serif;max-width:34rem;margin:15vh auto;padding:0 1.5rem;color:#0f172a">` +
      `<h1 style="font-size:1.25rem;margin:0 0 .75rem">You can't open this file</h1>` +
      `<p style="margin:0;color:#475569">NBFC files open only for Admin, the Sales Head, the CEO, the NBFC handling the application and the owner of the account.</p></div>`,
    { status: 403, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  );
}
