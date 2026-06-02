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
 * AUTH: these files include KYC PII, so the route now requires an authenticated
 * Supabase session. (Previously they were world-readable from public/ via a
 * static path — that's the hole this migration closes.)
 *
 * MIGRATION FALLBACK: if the object isn't in the bucket yet (not backfilled),
 * we fall back to reading the legacy file from `process.cwd()/public/
 * nbfc-uploads/` so nothing breaks during rollout. Run the backfill script
 * (scripts/backfill-nbfc-uploads-to-supabase.mjs) on the host, then the local
 * files can be removed.
 */
import path from "node:path";
import fs from "node:fs/promises";
import { NextRequest, NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { getNbfcObject } from "@/lib/nbfc/nbfc-storage";

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
};

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

  // Require an authenticated session — these are PII KYC documents.
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Reject path-traversal / absolute segments before forming the key.
  if (segments.some((s) => s === ".." || s.includes("\0") || path.isAbsolute(s))) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }
  const key = segments.join("/");
  const ext = path.extname(key).toLowerCase();

  // 1) Supabase (the new home).
  const fromBucket = await getNbfcObject(key);
  if (fromBucket) return fileResponse(fromBucket, ext);

  // 2) Legacy local disk fallback (pre-backfill). Same path-traversal guard as
  //    before: the resolved path must stay inside public/nbfc-uploads/.
  const root = path.join(process.cwd(), "public", "nbfc-uploads");
  const absPath = path.normalize(path.join(root, ...segments));
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (absPath !== root && !absPath.startsWith(rootWithSep)) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }
  try {
    const stat = await fs.stat(absPath);
    if (!stat.isFile()) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const buf = await fs.readFile(absPath);
    return fileResponse(buf, ext);
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
