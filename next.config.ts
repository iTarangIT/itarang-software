import type { NextConfig } from "next";
import path from "node:path";

const isDev = process.env.NODE_ENV !== "production";

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
      // Self-hosted brand fonts (public/fonts/). These are immutable content —
      // the filenames pin a specific subset of a specific font version, and a
      // new font means a new filename. They MUST be excluded from the no-store
      // catch-all below: leaving them in it would make the browser re-fetch
      // every woff2 on every single navigation, which is strictly worse than
      // the Google Fonts setup they replaced (that at least cached for a year).
      {
        source: "/fonts/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
          // Carried over from the catch-all below, which no longer matches
          // these paths — the `upload_headers` security probe checks this
          // header per-response, so dropping it here would register as a
          // regression even though a woff2 URL carries nothing sensitive.
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
      {
        // The exclusions here are what actually keep the two immutable rules
        // above effective. Next applies EVERY matching headers() entry and the
        // LATER one wins on a duplicate key, so a bare `/:path*` silently
        // overrode both.
        //
        // `_next/static` was a REAL, pre-existing bug, not a hypothetical:
        // `curl -I` on a built chunk returned `Cache-Control: no-store,
        // must-revalidate`, meaning every content-hashed JS/CSS chunk was
        // re-downloaded on every single navigation. That directly contradicts
        // the stated intent of the rule above ("Static assets are
        // content-hashed so they stay long-cacheable") — the rule was dead.
        // Content-hashed filenames change whenever the content does, so
        // caching them immutably cannot serve stale code; the anti-stale-deploy
        // measure that motivated no-store only needs to cover HTML, which it
        // still does.
        source: "/((?!fonts/|_next/static/).*)",
        headers: [
          { key: "Cache-Control", value: "no-store, must-revalidate" },
          { key: "Pragma", value: "no-cache" },
          // Stop full URLs (which can carry tokens/ids) leaking to third
          // parties via Referer — the `upload_headers` security probe flags
          // this when unset.
          { key: "Referrer-Policy", value: "no-referrer" },
          // ── Security headers. Each closes a finding raised by
          // securityHeadersProbe (src/lib/security/probes/upload_headers.ts).
          //
          // Browsers ignore HSTS over plain HTTP, so this is inert on
          // localhost and active on the HTTPS sandbox/prod hosts.
          // `preload` is deliberately NOT sent: submitting to the preload
          // list is a hard-to-reverse commitment that every current and
          // future subdomain is HTTPS-only.
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
          // Stop the browser second-guessing declared content types — the
          // matching half of the upload routes that store client-supplied
          // file.type without magic-byte sniffing.
          { key: "X-Content-Type-Options", value: "nosniff" },
          // Clickjacking. SAMEORIGIN rather than DENY because the app frames
          // its own pages — the document/PDF viewers embed same-origin
          // /api/files URLs in iframes. CSP frame-ancestors below is the
          // modern equivalent; both are sent for older-browser coverage.
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              // ⚠ 'unsafe-inline'/'unsafe-eval' are required by Next's inline
              // bootstrap and hydration scripts. Removing them needs
              // per-request nonce plumbing through middleware, which static
              // headers here cannot express. So script-src is NOT an XSS
              // barrier today — the value of this policy is the directives
              // below it (object/base/form/frame-ancestors), which are what
              // actually blunt injection and clickjacking.
              "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://checkout.razorpay.com",
              // Google Fonts is loaded via <link> in app/layout.tsx, not
              // next/font — the sandbox VPS can't reach it at build time.
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
              "font-src 'self' data: https://fonts.gstatic.com",
              // blob: covers the client-side document preview URLs; https:
              // covers S3/Supabase-served documents and map tiles.
              "img-src 'self' data: blob: https:",
              // `ws:` is dev-only: Next's HMR socket is plain ws:// on
              // localhost, and without it hot reload dies behind the CSP.
              // Production pages are https, where a ws:// connection would be
              // blocked as mixed content anyway.
              `connect-src 'self' https: wss:${isDev ? " ws:" : ""}`,
              // Razorpay checkout renders in an iframe; maps/doc viewers are
              // also framed. Own-origin blobs cover the PDF preview panes.
              "frame-src 'self' blob: https://checkout.razorpay.com https://api.razorpay.com https://www.google.com https://www.openstreetmap.org https://docs.google.com",
              // The clickjacking control proper.
              "frame-ancestors 'self'",
              // No Flash/Java-era plugin content, ever.
              "object-src 'none'",
              // Stop an injected <base> rewriting every relative URL on the
              // page to an attacker's host.
              "base-uri 'self'",
              // Stop an injected form posting credentials off-origin.
              "form-action 'self'",
            ].join("; "),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
