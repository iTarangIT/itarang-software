/**
 * GET /api/files/{bucket}/{...path}
 *
 * Authenticated proxy for the formerly-public storage buckets (`documents`,
 * `dealer-documents`, `call-recordings`). After the S3 migration these objects
 * are NOT public (Block Public Access ON), so they're served only through this
 * route, which streams the bytes from the active storage backend.
 *
 * The DB stores `/api/files/<bucket>/<key>` (a relative URL) for new uploads, so
 * <img>/<iframe>/<audio src> resolve here. Old rows holding absolute Supabase
 * URLs keep working until the Part C backfill rewrites them.
 *
 * Backend: reads from S3 when STORAGE_BACKEND=s3, else Supabase. There is no
 * fallback to the other backend any more (ID 166).
 *
 * AUTH: these include KYC PII and dealer financials, so EVERY read needs a
 * valid Supabase session (same as /api/nbfc-uploads) or a signed, expiring
 * link (?exp=&sig=, see fileAccess.ts). No bucket is open (ID 119): the
 * pre-login dealer onboarding form gets a signed link back from its upload,
 * and WhatsApp delivery signs what it sends.
 *
 * ID 166: a session alone is no longer enough. The file must be one this
 * login may open (fileRules.ts: Admin, Sales Head, CEO, the owner of the lead
 * or account, the dealer for its own customers, an NBFC for applications
 * shared with it, Finance for bills). Every customer KYC open is logged.
 */
import { NextRequest, NextResponse } from "next/server";

import { getAuthenticatedAppUser } from "@/lib/kyc/admin-workflow";
import { readBucketObject, contentTypeForName } from "@/lib/storage/readStoredDocument";
import { fileLinkTooLong, fileLinkValid, safeStorageKey } from "@/lib/storage/fileAccess";
import { canOpenStoredFile, logFileOpen } from "@/lib/storage/fileAuthz";
import { classifyFile, isKycFile, isLoggedFile } from "@/lib/storage/fileRules";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Only these logical buckets may be proxied here (nbfc-documents has its own
// route at /api/nbfc-uploads).
const ALLOWED_BUCKETS = new Set(["documents", "dealer-documents", "call-recordings"]);

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ bucket: string; path: string[] }> },
) {
  const { bucket, path: segments } = await ctx.params;

  if (!ALLOWED_BUCKETS.has(bucket)) {
    return NextResponse.json({ error: "Unknown bucket" }, { status: 404 });
  }
  if (!segments || segments.length === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Reject path traversal before anything else reads the path: `..` in any
  // encoding, slashes or control characters inside a segment (ID 128 — only a
  // plainly written ".." was refused before).
  const key = safeStorageKey(segments);
  if (!key) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  // A session, or a signed link for exactly this file. `dealer-documents` used
  // to be readable by anyone holding the link (it backed the pre-login
  // onboarding form); ID 119 closed it — that form now gets a signed link.
  // `by` is the user a fresh in-app link was minted for (GET /api/files/link);
  // it is inside the signature, so it cannot be swapped.
  const exp = req.nextUrl.searchParams.get("exp");
  const by = req.nextUrl.searchParams.get("by") || null;
  const file = classifyFile(bucket, key);
  // ID 166: a link to a customer KYC file lives 15 minutes at most. A KYC link
  // expiring further out was minted with a longer life, so it is not honoured
  // (the viewer can still open the file with a session if allowed).
  const signedLink =
    fileLinkValid(bucket, key, exp, req.nextUrl.searchParams.get("sig"), Date.now(), by) &&
    !(isKycFile(file) && fileLinkTooLong(exp));
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
  if (signedLink) {
    // The signature was minted for exactly this file by someone allowed to
    // open or share it (a fresh in-app link, WhatsApp delivery, the pre-login
    // onboarding form).
    await logFileOpen({ file, bucket, key, userId: by, role: null, via: "signed_link", allowed: true, ip });
  } else {
    // No valid signature (none, expired, or forged): the session decides. ID
    // 119: a dealer whose 7-day onboarding link ran out opens the file here if
    // signed in as the dealer that owns it; signed out, they get a way back to
    // the application instead of a dead end.
    let user: Awaited<ReturnType<typeof getAuthenticatedAppUser>> = null;
    try {
      user = await getAuthenticatedAppUser();
    } catch {
      user = null;
    }
    if (!user) return file.kind === "dealer_onboarding" ? onboardingLinkExpired(req) : unauthorized(req);

    const { allowed } = await canOpenStoredFile(user, bucket, key);
    await logFileOpen({ file, bucket, key, userId: user.id, role: user.role, via: "session", allowed, ip });
    if (!allowed) return forbidden(req);
  }

  const contentType = contentTypeForName(key);

  // The active backend only (the old-storage fallback was removed, ID 166).
  const buf = await readBucketObject(bucket, key);
  if (!buf) return notFound(req, key);

  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": "inline",
      "Content-Length": String(buf.byteLength),
      // Upload keys are timestamp-unique (see upload-document/route.ts:
      // `${docType}_${Date.now()}.${ext}`) and their bytes never change — a
      // re-upload mints a NEW key/URL. So the object at any given URL is
      // effectively immutable and safe to cache hard. `private` keeps PII out
      // of shared/CDN caches while still letting the browser reuse the bytes,
      // so preview thumbnails stop re-downloading the full file (and re-hitting
      // the Supabase auth check) on every page load and re-render.
      // ID 166: a logged file (customer KYC, onboarding papers) is fetched
      // (and so logged) on every open; other files keep the browser cache.
      "Cache-Control": isLoggedFile(file) ? "private, no-store" : "private, max-age=3600, immutable",
    },
  });
}

/** 401, as a readable page when a person opened the link in a browser. */
function unauthorized(req: NextRequest) {
  if (!(req.headers.get("accept") || "").includes("text/html")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return new NextResponse(
    `<!doctype html><meta charset="utf-8"><title>Unauthorized</title>` +
      `<div style="font:15px/1.6 system-ui,sans-serif;max-width:34rem;margin:15vh auto;padding:0 1.5rem;color:#0f172a">` +
      `<h1 style="font-size:1.25rem;margin:0 0 .75rem">Unauthorized</h1>` +
      `<p style="margin:0;color:#475569">Please log in to the iTarang CRM to view this document.</p></div>`,
    { status: 401, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  );
}

/**
 * ID 119: an onboarding upload's link (7 days, made at upload) ran out and
 * nobody is signed in. Not "please log in" — before approval the dealer has no
 * login — but the way back: continue the application (a code to the
 * registered mobile proves it is theirs and gives fresh links), or log in once
 * approved. JSON callers keep the plain 401.
 */
function onboardingLinkExpired(req: NextRequest) {
  if (!(req.headers.get("accept") || "").includes("text/html")) {
    return NextResponse.json({ error: "Unauthorized", code: "link_expired" }, { status: 401 });
  }
  const btn =
    "display:inline-block;padding:.6rem 1.1rem;border-radius:.75rem;font-weight:600;text-decoration:none;margin:0 .5rem .5rem 0";
  return new NextResponse(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link expired</title>` +
      `<div style="font:15px/1.6 system-ui,sans-serif;max-width:34rem;margin:15vh auto;padding:0 1.5rem;color:#0f172a">` +
      `<h1 style="font-size:1.25rem;margin:0 0 .75rem">This document link has expired</h1>` +
      `<p style="margin:0 0 1rem;color:#475569">Links to your onboarding documents work for 7 days. To see your documents again, continue your application: we send a code to your registered mobile number, and once you enter it your documents open again.</p>` +
      `<p style="margin:0 0 1.25rem"><a href="/dealer-onboarding" style="${btn};background:#1F5C8F;color:#fff">Continue my application</a>` +
      `<a href="/login" style="${btn};border:1px solid #cbd5e1;color:#334155">Log in (approved dealers)</a></p>` +
      `<p style="margin:0;color:#64748b;font-size:13px">If you did not apply, you can close this page.</p></div>`,
    { status: 401, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  );
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
      `<p style="margin:0;color:#475569">Files open only for Admin, the Sales Head, the CEO and the owner of the lead or account. Ask one of them if you need it.</p></div>`,
    { status: 403, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  );
}

/**
 * 404 for a missing object. A handful of pre-S3-migration rows point at objects
 * that never made it into S3 (the source Supabase project has since been
 * deleted), and these links are opened in a browser tab from the admin review
 * pages — raw `{"error":"Not found"}` reads like a system fault. Explain it
 * instead, and keep JSON for programmatic callers.
 */
function notFound(req: NextRequest, key: string) {
  if (!(req.headers.get("accept") || "").includes("text/html")) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const name = escapeHtml(key.split("/").pop() || key);
  return new NextResponse(
    `<!doctype html><meta charset="utf-8"><title>File unavailable</title>` +
      `<div style="font:15px/1.6 system-ui,sans-serif;max-width:34rem;margin:15vh auto;padding:0 1.5rem;color:#0f172a">` +
      `<h1 style="font-size:1.25rem;margin:0 0 .75rem">This file is no longer stored</h1>` +
      `<p style="margin:0 0 .75rem;color:#475569">The record still references <code style="background:#f1f5f9;padding:.1rem .3rem;border-radius:.25rem">${name}</code>, but the file itself was not carried over from the old storage provider.</p>` +
      `<p style="margin:0;color:#475569">Ask the dealer to re-upload it — the new copy will save and open normally.</p></div>`,
    { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}
