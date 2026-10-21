import React from "react";
import { LayoutWrapper } from "@/components/layout/LayoutWrapper";
import { enforceAccountGate } from "@/lib/auth/passwordMeta";

// Every dashboard route is auth-gated and renders per-request, per-user data —
// none can be meaningfully static-prerendered. Forcing the whole route group
// dynamic here (rather than reactively, page by page) stops Next.js from
// attempting static generation, which was failing the production build with
// "useSearchParams() should be wrapped in a suspense boundary".
export const dynamic = "force-dynamic";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // A39: a deactivated login goes to the login page; a forced or 90-day-old
  // password to /change-password — every role, every dashboard page.
  await enforceAccountGate();
  return <LayoutWrapper>{children}</LayoutWrapper>;
}