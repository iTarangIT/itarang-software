/**
 * GET /api/nbfc-uploads/{...path}
 *
 * Serves files uploaded at runtime under public/nbfc-uploads/ (compliance
 * documents, LSP agreement templates, signer identity docs, cached signed
 * PDFs, etc.).
 *
 * WHY THIS EXISTS — production serving bug:
 *   In Next.js `output: "standalone"`, the bundled server serves the
 *   `public/` directory from its OWN build copy (sandbox: `current/public/`
 *   inside the immutable release; prod: `.next/standalone/public/`). But the
 *   upload routes write to `process.cwd()/public/nbfc-uploads/` — the pm2
 *   working dir (`$APP_DIR/public/...`), which is a DIFFERENT directory than
 *   the standalone server's bundled `public/`. So every runtime-uploaded file
 *   requested at its static URL `/nbfc-uploads/...` misses the static handler
 *   and falls through to the app's catch-all "Page Not Found" page.
 *
 *   This route reads from the SAME cwd-relative directory the upload routes
 *   write to, so what's written is always what's served — independent of the
 *   standalone bundle layout. A `afterFiles` rewrite in next.config.ts maps
 *   `/nbfc-uploads/:path*` here when the static file isn't found, so existing
 *   stored URLs (`/nbfc-uploads/...`) keep working with no DB migration.
 *
 * Security: the resolved path is constrained to stay inside the
 * public/nbfc-uploads/ root (path-traversal guard). Exposure level is
 * identical to the previous static-file serving (these lived in public/).
 */
import path from "node:path";
import fs from "node:fs/promises";
import { NextRequest, NextResponse } from "next/server";

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

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> },
) {
  const { path: segments } = await ctx.params;
  if (!segments || segments.length === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const root = path.join(process.cwd(), "public", "nbfc-uploads");
  // Resolve + normalize, then confirm the result is still inside `root`
  // (path-traversal guard). Next.js already URL-decodes catch-all segments,
  // so no manual decodeURIComponent here.
  const absPath = path.normalize(path.join(root, ...segments));
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (absPath !== root && !absPath.startsWith(rootWithSep)) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  let buf: Buffer;
  try {
    const stat = await fs.stat(absPath);
    if (!stat.isFile()) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    buf = await fs.readFile(absPath);
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const ext = path.extname(absPath).toLowerCase();
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
