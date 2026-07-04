import { redirect, notFound } from "next/navigation";
import { PageShell } from "@/components/layout/PageShell";
import { requireAuth } from "@/lib/auth-utils";
import { getNbfcDetail } from "@/lib/calculator/admin-service";
import { NbfcDetailClient } from "@/components/admin/calculator/NbfcDetailClient";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ nbfcId: string }> }) {
  let user;
  try {
    user = await requireAuth();
  } catch {
    redirect("/login");
  }
  if (!["admin", "sales_head"].includes(user.role)) redirect("/login");

  const { nbfcId } = await params;
  const detail = await getNbfcDetail(Number(nbfcId));
  if (!detail) notFound();

  return (
    <PageShell
      eyebrow="LOAN CALCULATOR"
      title={detail.nbfc.name}
      subtitle="Edit this NBFC's constants, schemes, and (Variant B) per-model caps. Every change is versioned and audited."
      breadcrumb={[
        { label: "Admin", href: "/admin" },
        { label: "Loan Calculator", href: "/admin/calculator" },
        { label: detail.nbfc.name },
      ]}
    >
      <NbfcDetailClient
        nbfc={detail.nbfc as never}
        schemes={detail.schemes as never}
        caps={detail.caps as never}
        models={detail.models as never}
      />
    </PageShell>
  );
}
