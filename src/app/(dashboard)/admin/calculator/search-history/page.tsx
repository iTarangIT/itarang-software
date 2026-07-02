import { redirect } from "next/navigation";
import { PageShell } from "@/components/layout/PageShell";
import { requireAuth } from "@/lib/auth-utils";
import { getSearchHistory } from "@/lib/calculator/admin-service";
import { SearchHistoryClient } from "@/components/admin/calculator/SearchHistoryClient";

export const dynamic = "force-dynamic";

export default async function Page() {
  let user;
  try {
    user = await requireAuth();
  } catch {
    redirect("/login");
  }
  if (!["admin", "sales_head"].includes(user.role)) redirect("/login");

  const entries = await getSearchHistory(200);

  return (
    <PageShell
      eyebrow="LOAN CALCULATOR"
      title="Search History"
      subtitle="Every customer calculation, newest first — who searched, whether their WhatsApp number was OTP-verified, and which schemes they were shown and sent."
      breadcrumb={[
        { label: "Admin", href: "/admin" },
        { label: "Loan Calculator", href: "/admin/calculator" },
        { label: "Search History" },
      ]}
    >
      <SearchHistoryClient entries={entries} />
    </PageShell>
  );
}
