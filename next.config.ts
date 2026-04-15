import type { NextConfig } from "next";

// force-rebuild: vercel
const nextConfig = {
  output: "standalone",
  images: {
    unoptimized: true,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
};

export default nextConfig;
