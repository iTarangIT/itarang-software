import type { Metadata } from "next";
import "./globals.css";

import Providers from "@/components/Providers";
import { AuthProvider } from "@/components/auth/AuthProvider";
import ChangePasswordModal from "@/components/auth/ChangePasswordModal";
import ChunkReloadGuard from "@/components/ChunkReloadGuard";
import { ConfirmDialogHost } from "@/components/ui/confirm-dialog";
import { WhatsAppFab } from "@/components/shared/whatsapp-fab";
import { Toaster } from "sonner";

export const metadata: Metadata = {
  title: "iTarang CRM",
  description: "iTarang dealer and admin CRM",
};

// iTarang BRD §6.B — DM Sans (body) + DM Mono (IDs / IMEI / hex).
//
// The @font-face rules live in globals.css and point at self-hosted woff2 files
// in public/fonts/. This replaced a render-blocking third-party stylesheet from
// fonts.googleapis.com, which forced every page to wait on a DNS lookup + TLS
// handshake + stylesheet fetch on one foreign origin before it could even
// discover the font URLs on a second one (fonts.gstatic.com).
//
// next/font is still deliberately NOT used — the sandbox VPS cannot reach
// fonts.googleapis.com during `next build`, so next/font emits manifest entries
// for woff2 files it never writes to disk and silently takes out every
// dependent CSS/JS chunk (the 19 NOT-ON-DISK / HTTP 500 chunks the deploy
// verifier once caught). Self-hosting avoids build-time network entirely.
//
// Only the DM Sans latin subset is preloaded — it is the body font, so every
// page renders with it. DM Mono (IDs / IMEI / hex) and both latin-ext subsets
// are deliberately left unpreloaded: they are conditional on what a given page
// actually shows, and preloading a font the page never uses just competes for
// bandwidth with the resources it does need.
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <link
          rel="preload"
          href="/fonts/dm-sans-latin.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
      </head>
      <body suppressHydrationWarning>
        <ChunkReloadGuard />
        <Providers>
          <AuthProvider>
            {children}
            {/* E-213 — one instance for all four triggers (both headers, the
                Risk Head shell, the profile Security card). Must sit INSIDE
                AuthProvider, not beside ConfirmDialogHost below, because it
                reads useAuth() for the registered address. */}
            <ChangePasswordModal />
          </AuthProvider>
        </Providers>
        <Toaster position="top-right" richColors closeButton duration={4000} />
        <ConfirmDialogHost />
        {/* Env override is optional — the fallback WABA number lives in
            src/lib/whatsapp/chat-link.ts. */}
        <WhatsAppFab number={process.env.WHATSAPP_ONBOARDING_NUMBER} />
      </body>
    </html>
  );
}
