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
import {
  FRESH_LINK_TTL_SECONDS,
  fileLinkTooLong,
  fileLinkValid,
  safeStorageKey,
  signedNbfcPath,
} from "@/lib/storage/fileAccess";
import { canOpenStoredFile, logFileOpen } from "@/lib/storage/fileAuthz";
import { classifyFile, NBFC_FILE_BUCKET } from "@/lib/storage/fileRules";

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
  // ID 166 (4 Nov): a signed link for exactly this file, never honoured for
  // more than 15 minutes — any NBFC file, not only identity files (same rule
  // as /api/files).
  const signatureOk =
    fileLinkValid(bucket, key, exp, req.nextUrl.searchParams.get("sig"), Date.now(), by) &&
    !fileLinkTooLong(exp);
  // 17 Oct (user): every open needs a login; a signed link opens only for the
  // login it was minted for (`by`). Same rule as /api/files.
  const user = await sessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const signedLink = signatureOk && !!by && user.id === by;

  if (signedLink) {
    await logFileOpen({ file, bucket, key, userId: by, role: null, via: "signed_link", allowed: true, ip });
    return serve(key);
  }

  // No link for this login: the file rule decides for the signed-in user.
  const { allowed } = await canOpenStoredFile(user, bucket, key);
  if (!allowed) {
    await logFileOpen({ file, bucket, key, userId: user.id, role: user.role, via: "session", allowed, ip });
    return forbidden(req);
  }

  // ID 166 (decided 4 Nov, as /api/files): the plain stored address never
  // serves the bytes. An allowed login is sent on to a fresh 15-minute link
  // made for it; <img>, <video> and old links keep working (same origin, the
  // redirect carries the session). Relative Location — behind the proxy
  // req.nextUrl.origin can be the internal host.
  const fresh = signedNbfcPath(`/api/nbfc-uploads/${key.split("/").map(encodeURIComponent).join("/")}`, FRESH_LINK_TTL_SECONDS, {
    by: user.id,
  });
  if (fresh && fresh.includes("sig=")) {
    await logFileOpen({ file, bucket, key, userId: user.id, role: user.role, via: "session_redirect", allowed, ip });
    return new NextResponse(null, {
      status: 302,
      headers: { Location: fresh, "Cache-Control": "private, no-store" },
    });
  }
  // No signing secret configured (dev): serve on the session, as before.
  await logFileOpen({ file, bucket, key, userId: user.id, role: user.role, via: "session", allowed, ip });
  return serve(key);
}

async function serve(key: string) {
  const buf = await getNbfcObject(key);
  if (!buf) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return fileResponse(buf, extOf(key));
}

async function sessionUser(): Promise<Awaited<ReturnType<typeof getAuthenticatedAppUser>>> {
  try {
    return await getAuthenticatedAppUser();
  } catch {
    return null;
  }
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
