import type { Metadata } from "next";
import { DM_Sans, DM_Mono } from "next/font/google";
import "./globals.css";

import Providers from "@/components/Providers";
import { AuthProvider } from "@/components/auth/AuthProvider";
import ChunkReloadGuard from "@/components/ChunkReloadGuard";
import { Toaster } from "sonner";

// iTarang BRD §6.B — DM Sans for body, DM Mono for IDs / IMEI / hex codes.
const dmSans = DM_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-dm-sans",
  display: "swap",
});

const dmMono = DM_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-dm-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "iTarang CRM",
  description: "iTarang dealer and admin CRM",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${dmSans.variable} ${dmMono.variable}`}>
      <body className={dmSans.className} suppressHydrationWarning>
        <ChunkReloadGuard />
        <Providers>
          <AuthProvider>{children}</AuthProvider>
        </Providers>
        <Toaster position="top-right" richColors closeButton duration={4000} />
      </body>
    </html>
  );
}
