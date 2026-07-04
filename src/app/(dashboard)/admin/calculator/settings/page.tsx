import { redirect } from "next/navigation";
import { PageShell } from "@/components/layout/PageShell";
import { requireAuth } from "@/lib/auth-utils";
import { getSettings } from "@/lib/calculator/admin-service";
import { SettingsClient } from "@/components/admin/calculator/SettingsClient";

export const dynamic = "force-dynamic";

export default async function Page() {
  let user;
  try {
    user = await requireAuth();
  } catch {
    redirect("/login");
  }
  if (!["admin", "sales_head"].includes(user.role)) redirect("/login");

  const settings = await getSettings();

  return (
    <PageShell
      eyebrow="LOAN CALCULATOR"
      title="Calculator Settings"
      subtitle="Dealer margin, stretch window, filter requirements, and the Card-2 footer. Saved changes are versioned."
      breadcrumb={[{ label: "Admin", href: "/admin" }, { label: "Loan Calculator", href: "/admin/calculator" }, { label: "Settings" }]}
    >
      <SettingsClient initial={settings as never} />
    </PageShell>
  );
}
