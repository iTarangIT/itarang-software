import React from "react";
import { LayoutWrapper } from "@/components/layout/LayoutWrapper";
import { requireAuth } from "@/lib/auth-utils";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  let initialUser = null;

  try {
    const user = await requireAuth();
    initialUser = {
      id: user.id,
      email: user.email || "",
      role: user.role,
      name: ("name" in user && typeof user.name === "string") ? user.name : null,
      dealer_id: ("dealer_id" in user && typeof user.dealer_id === "string") ? user.dealer_id : null,
      phone: ("phone" in user && typeof user.phone === "string") ? user.phone : null,
      avatar_url: ("avatar_url" in user && typeof user.avatar_url === "string") ? user.avatar_url : null,
      onboarding_status: user.onboarding_status ?? null,
      review_status: user.review_status ?? null,
      dealer_account_status: user.dealer_account_status ?? null,
    };
  } catch {
    // Auth failed — LayoutWrapper will render with no initial user,
    // and AuthProvider will handle the redirect via its own flow.
  }

  return <LayoutWrapper initialUser={initialUser}>{children}</LayoutWrapper>;
}
