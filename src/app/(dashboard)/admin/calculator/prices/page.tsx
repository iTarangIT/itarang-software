import { redirect } from "next/navigation";
import { PageShell } from "@/components/layout/PageShell";
import { requireAuth } from "@/lib/auth-utils";
import { getModelsWithPrices } from "@/lib/calculator/admin-service";
import { PricesClient } from "@/components/admin/calculator/PricesClient";

export const dynamic = "force-dynamic";

export default async function Page() {
  let user;
  try {
    user = await requireAuth();
  } catch {
    redirect("/login");
  }
  if (!["admin", "sales_head"].includes(user.role)) redirect("/login");

  const models = await getModelsWithPrices();

  return (
    <PageShell
      eyebrow="LOAN CALCULATOR"
      title="Asset & Component Prices"
      subtitle="Per-model battery, charger, harness, SoC and IoT prices (₹, with GST multiplier). Editing a price re-prices that model on the calculator immediately; the old value stays reproducible."
      breadcrumb={[{ label: "Admin", href: "/admin" }, { label: "Loan Calculator", href: "/admin/calculator" }, { label: "Prices" }]}
    >
      <PricesClient models={models} />
    </PageShell>
  );
}
