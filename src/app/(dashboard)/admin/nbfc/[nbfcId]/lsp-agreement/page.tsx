/**
 * E-007 — admin page: /admin/nbfc/{nbfcId}/lsp-agreement
 * Hosts the NbfcLspAgreementPanel client component.
 */
import NbfcLspAgreementPanel from "@/components/admin/nbfc/NbfcLspAgreementPanel";

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
      <div className="p-6 text-sm text-red-700">Invalid NBFC id: {nbfcId}</div>
    );
  }
  return <NbfcLspAgreementPanel nbfcId={id} />;
}
