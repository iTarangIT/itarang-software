import React from "react";
import { LayoutWrapper } from "@/components/layout/LayoutWrapper";

// Every dashboard route is auth-gated and renders per-request, per-user data —
// none can be meaningfully static-prerendered. Forcing the whole route group
// dynamic here (rather than reactively, page by page) stops Next.js from
// attempting static generation, which was failing the production build with
// "useSearchParams() should be wrapped in a suspense boundary".
export const dynamic = "force-dynamic";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <LayoutWrapper>{children}</LayoutWrapper>;
}