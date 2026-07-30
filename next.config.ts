import type { NextConfig } from "next";
import path from "node:path";

// force-rebuild: vercel
const nextConfig: NextConfig = {
  output: "standalone",
  // Pin the workspace root to THIS project. A stray package-lock.json in a
  // parent dir (e.g. C:\Users\<user>\package-lock.json) makes Next infer the
  // whole home folder as the root, so file-tracing + the webpack cache try to
  // walk all of it (OneDrive, Downloads, every node_modules) and blow the heap:
  //   RangeError: Array buffer allocation failed  (PackFileCacheStrategy)
  // Scoping tracing to __dirname stops the OOM and fixes the standalone bundle
  // copying the wrong tree.
  outputFileTracingRoot: path.join(__dirname),
  generateBuildId: async () => process.env.GITHUB_SHA?.slice(0, 12) || "dev",
  images: {
    unoptimized: true,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  // Don't try to bundle these into the serverless function — puppeteer-core
  // loads the Chromium binary at runtime from @sparticuz/chromium, and the
  // full `puppeteer` dep is only used for local Windows dev and must not be
  // traced into Vercel's 50MB function bundle.
  serverExternalPackages: [
    "puppeteer",
    "puppeteer-core",
    "@sparticuz/chromium",
    // mupdf ships a wasm asset and is ESM-only; let the runtime load it
    // directly instead of webpack trying to bundle the wasm into the
    // standalone server. Used by src/lib/ocr/pdfToImage.ts to rasterize PDFs.
    "mupdf",
  ],
  outputFileTracingExcludes: {
    "/api/kyc/*/generate-consent-pdf": [
      "./node_modules/puppeteer/**/*",
      "./node_modules/.cache/puppeteer/**/*",
    ],
  },
  // Runtime-uploaded files under public/nbfc-uploads/ (compliance docs, LSP
  // agreement templates, signer identity docs) are written to
  // process.cwd()/public/nbfc-uploads — a DIFFERENT directory than the
  // `output: "standalone"` server's bundled public/. So the static handler
  // can't find them and the request falls through to the catch-all 404 page
  // (the "Page Not Found" cards in the LSP agreement panel + every doc View
  // link). `afterFiles` runs AFTER the public/static check, so build-time
  // assets still serve directly from public/ and only the missing runtime
  // uploads route to /api/nbfc-uploads, which reads from the same
  // cwd-relative dir the upload routes write to. Existing stored URLs stay
  // `/nbfc-uploads/...` — no DB migration needed.
  async rewrites() {
    return {
      afterFiles: [
        {
          source: "/nbfc-uploads/:path*",
          destination: "/api/nbfc-uploads/:path*",
        },
      ],
      beforeFiles: [],
      fallback: [],
    };
  },
  // Stop browsers and any reverse proxy from holding onto stale HTML across
  // deploys. Cached HTML pins references to a previous BUILD_ID's chunks,
  // which the next deploy wipes — that was the ChunkLoadError loop. Static
  // assets are content-hashed so they stay long-cacheable.
  async headers() {
    return [
      {
        source: "/_next/static/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
      {
        source: "/:path*",
        headers: [
          { key: "Cache-Control", value: "no-store, must-revalidate" },
          { key: "Pragma", value: "no-cache" },
          // Stop full URLs (which can carry tokens/ids) leaking to third
          // parties via Referer — the `upload_headers` security probe flags
          // this when unset.
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
};

export default nextConfig;
