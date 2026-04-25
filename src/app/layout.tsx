import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

import Providers from "@/components/Providers";
import { AuthProvider } from "@/components/auth/AuthProvider";
import ChunkReloadGuard from "@/components/ChunkReloadGuard";
import { Toaster } from "sonner";

const inter = Inter({ subsets: ["latin"] });

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
    <html lang="en">
      <body className={inter.className}>
        <ChunkReloadGuard />
        <Providers>
          <AuthProvider>{children}</AuthProvider>
        </Providers>
        <Toaster position="top-right" richColors closeButton duration={4000} />
      </body>
    </html>
  );
}