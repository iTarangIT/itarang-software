import type { NextConfig } from "next";

const nextConfig = {
  output: "standalone",
  outputFileTracingRoot: __dirname,
  images: {
    unoptimized: true,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
