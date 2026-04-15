import type { NextConfig } from "next";

const nextConfig = {
  output: "standalone",
  images: {
    unoptimized: true,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  // Turbopack sometimes picks the parent user directory as the workspace
  // because there is another lockfile in C:\Users\Aniket. Explicitly pin
  // the project root so all app routes (including dynamic ones like
  // /admin/dealer-verification/[dealerId]) are discovered and compiled.
  turbo: {
    root: __dirname,
  }
};

export default nextConfig;
