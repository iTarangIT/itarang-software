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
 * Backend: reads from S3 when STORAGE_BACKEND=s3, else Supabase — with a fallback
 * to the other backend so nothing breaks mid-migration.
 *
 * AUTH: these include KYC PII, so a valid Supabase session is required (same as
 * /api/nbfc-uploads).
 */
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { readBucketObject, contentTypeForName } from "@/lib/storage/readStoredDocument";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Only these logical buckets may be proxied here (nbfc-documents has its own
// route at /api/nbfc-uploads).
const ALLOWED_BUCKETS = new Set(["documents", "dealer-documents", "call-recordings"]);

// Buckets that require an authenticated Supabase session to read.
//
// `dealer-documents` is intentionally EXCLUDED: dealer onboarding is a public,
// pre-login flow (the login page's "Create one" link lands a prospective dealer
// on /dealer-onboarding with no session) and its upload endpoint
// (/api/uploads/dealer-documents) is itself unauthenticated. Requiring a session
// to read what an anonymous user just uploaded is the bug — the dealer clicks
// "View uploaded file" and gets {"error":"Unauthorized"}. This bucket was also
// a public Supabase bucket before the S3 migration, so anonymous reads here just
// restore the prior behavior. Keys are random UUIDs (not enumerable).
const AUTH_REQUIRED_BUCKETS = new Set(["documents", "call-recordings"]);

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

  // Require an authenticated session for PII buckets. `dealer-documents` is
  // served without a session because its write side is anonymous (public
  // onboarding) — see AUTH_REQUIRED_BUCKETS above.
  if (AUTH_REQUIRED_BUCKETS.has(bucket)) {
    try {
      const supabase = await createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    } catch {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  // Reject path traversal / absolute segments.
  if (segments.some((s) => s === ".." || s.includes("\0") || path.isAbsolute(s))) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }
  const key = segments.join("/");
  const contentType = contentTypeForName(key);

  // Primary backend, then fall back to the other (migration safety).
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
      "Cache-Control": "private, max-age=3600, immutable",
    },
  });
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
