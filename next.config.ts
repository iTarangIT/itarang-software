import type { NextConfig } from "next";

// force-rebuild: vercel
const nextConfig: NextConfig = {
  output: "standalone",
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
    "@sparticuz/chromium-min",
  ],
  outputFileTracingExcludes: {
    "/api/kyc/*/generate-consent-pdf": [
      "./node_modules/puppeteer/**/*",
      "./node_modules/.cache/puppeteer/**/*",
    ],
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
        ],
      },
    ];
  },
};

export default nextConfig;
