import type { Metadata } from "next";
import "./globals.css";

import Providers from "@/components/Providers";
import { AuthProvider } from "@/components/auth/AuthProvider";
import ChunkReloadGuard from "@/components/ChunkReloadGuard";
import { Toaster } from "sonner";

export const metadata: Metadata = {
  title: "iTarang CRM",
  description: "iTarang dealer and admin CRM",
};

// iTarang BRD §6.B — DM Sans (body) + DM Mono (IDs / IMEI / hex). Fonts are
// loaded by the browser at runtime via the <link> tag below, NOT by next/font
// at build time. The sandbox VPS cannot reach fonts.googleapis.com during
// `next build`; next/font then writes manifest entries pointing at woff2
// files it never emits to disk, and every chunk that depends on those font
// modules (CSS chunks, downstream JS chunks) silently goes missing too,
// surfacing as the 19 NOT-ON-DISK / HTTP 500 chunks the deploy verifier
// caught. Loading via <link> sidesteps build-time network entirely; the
// browser fetches Google Fonts on first page load with --font-dm-sans /
// --font-dm-mono falling back to system fonts via globals.css.
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:wght@400;500;600;700&display=swap"
        />
      </head>
      <body suppressHydrationWarning>
        <ChunkReloadGuard />
        <Providers>
          <AuthProvider>{children}</AuthProvider>
        </Providers>
        <Toaster position="top-right" richColors closeButton duration={4000} />
      </body>
    </html>
  );
}
