import NbfcLoanProductForm from "@/components/admin/nbfc/NbfcLoanProductForm";
import { PageShell, buildNbfcSteps } from "@/components/layout/PageShell";

// E-009 — /admin/nbfc/[nbfcId]/loan-products
// Admin page for configuring per-NBFC loan products (BRD §6.0.5).

export const dynamic = "force-dynamic";

export default async function Page({
  params,
}: {
  params: Promise<{ nbfcId: string }>;
}) {
  const { nbfcId: nbfcIdRaw } = await params;
  const nbfcId = Number.parseInt(nbfcIdRaw, 10);

  return (
    <PageShell
      eyebrow="Loan Products"
      title="Per-NBFC catalogue"
      subtitle={`Only products with status "active" appear in the dealer loan-sanction form. Per BRD §6.0.5.`}
      breadcrumb={[
        { label: "Admin", href: "/admin" },
        { label: "NBFC", href: "/admin/nbfc" },
        { label: nbfcIdRaw },
        { label: "Loan Products" },
      ]}
      steps={buildNbfcSteps({
        active: "loan-products",
        done: ["master", "documents", "lsp", "approval", "activation"],
      })}
    >
      <NbfcLoanProductForm nbfcId={nbfcId} />
    </PageShell>
  );
}
