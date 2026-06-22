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
import { supabaseAdmin } from "@/lib/supabase/admin";
import { isS3Backend, getObject } from "@/lib/storage/s3";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Only these logical buckets may be proxied here (nbfc-documents has its own
// route at /api/nbfc-uploads).
const ALLOWED_BUCKETS = new Set(["documents", "dealer-documents", "call-recordings"]);

const CONTENT_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".csv": "text/csv",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

async function fromSupabase(bucket: string, key: string): Promise<Buffer | null> {
  const { data, error } = await supabaseAdmin.storage.from(bucket).download(key);
  if (error || !data) return null;
  return Buffer.from(await data.arrayBuffer());
}

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

  // Require an authenticated session — these are PII documents.
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Reject path traversal / absolute segments.
  if (segments.some((s) => s === ".." || s.includes("\0") || path.isAbsolute(s))) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }
  const key = segments.join("/");
  const ext = path.extname(key).toLowerCase();
  const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";

  // Primary backend, then fall back to the other (migration safety).
  let buf: Buffer | null = null;
  try {
    buf = isS3Backend ? await getObject(bucket, key) : await fromSupabase(bucket, key);
    if (!buf) buf = isS3Backend ? await fromSupabase(bucket, key) : await getObject(bucket, key);
  } catch {
    buf = null;
  }
  if (!buf) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": "inline",
      "Content-Length": String(buf.byteLength),
    },
  });
}
