import { redirect } from "next/navigation";
import { PageShell } from "@/components/layout/PageShell";
import { requireAuth } from "@/lib/auth-utils";
import { getCoverage } from "@/lib/calculator/admin-service";
import { EligibilityClient } from "@/components/admin/calculator/EligibilityClient";

export const dynamic = "force-dynamic";

export default async function Page() {
  let user;
  try {
    user = await requireAuth();
  } catch {
    redirect("/login");
  }
  if (!["admin", "sales_head"].includes(user.role)) redirect("/login");

  const groups = await getCoverage();

  return (
    <PageShell
      eyebrow="LOAN CALCULATOR"
      title="City → NBFC Eligibility"
      subtitle="Which cities each NBFC serves. Pan-India NBFCs (e.g. Bajaj) apply everywhere. A city may map to multiple NBFCs."
      breadcrumb={[{ label: "Admin", href: "/admin" }, { label: "Loan Calculator", href: "/admin/calculator" }, { label: "Eligibility" }]}
    >
      <EligibilityClient groups={groups as never} />
    </PageShell>
  );
}
