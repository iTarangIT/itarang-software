/**
 * E-007 — admin page: /admin/nbfc/{nbfcId}/lsp-agreement
 * Hosts the NbfcLspAgreementPanel client component.
 */
import NbfcLspAgreementPanel from "@/components/admin/nbfc/NbfcLspAgreementPanel";
import { PageShell, buildNbfcSteps } from "@/components/layout/PageShell";

export const dynamic = "force-dynamic";

export default async function Page({
  params,
}: {
  params: Promise<{ nbfcId: string }>;
}) {
  const { nbfcId } = await params;
  const id = Number.parseInt(nbfcId, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return (
      <PageShell title="LSP Agreement" subtitle={`Invalid NBFC id: ${nbfcId}`}>
        <div className="card-iTarang p-6 text-sm" style={{ color: "var(--color-danger)" }}>
          The NBFC id in the URL is not a valid integer.
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell
      eyebrow="LSP Agreement"
      title="Initiate sequential signing"
      subtitle="Sequential signing through Digio: NBFC signatory first, then iTarang's two authorised signatories."
      breadcrumb={[
        { label: "Admin", href: "/admin" },
        { label: "NBFC", href: "/admin/nbfc" },
        { label: nbfcId },
        { label: "LSP Agreement" },
      ]}
      steps={buildNbfcSteps({ active: "lsp", done: ["master", "documents"] })}
    >
      <NbfcLspAgreementPanel nbfcId={id} />
    </PageShell>
  );
}
