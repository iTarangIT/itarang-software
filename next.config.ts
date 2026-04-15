import type { NextConfig } from "next";

// force-rebuild: vercel
const nextConfig: NextConfig = {
  output: "standalone",
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
};

export default nextConfig;
