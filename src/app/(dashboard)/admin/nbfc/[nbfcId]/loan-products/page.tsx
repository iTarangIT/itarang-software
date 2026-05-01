import NbfcLoanProductForm from "@/components/admin/nbfc/NbfcLoanProductForm";

// E-009 — /admin/nbfc/[nbfcId]/loan-products
// Admin page for configuring per-NBFC loan products (BRD 6.0.5).

export default async function Page({
  params,
}: {
  params: Promise<{ nbfcId: string }>;
}) {
  const { nbfcId: nbfcIdRaw } = await params;
  const nbfcId = Number.parseInt(nbfcIdRaw, 10);

  return (
    <div className="p-6">
      <h1 className="text-2xl font-semibold mb-4">
        NBFC Loan Products
      </h1>
      <p className="text-sm text-gray-600 mb-6">
        Configure loan products for this NBFC. Only products with status
        &ldquo;active&rdquo; will appear in the dealer loan-sanction form.
      </p>
      <NbfcLoanProductForm nbfcId={nbfcId} />
    </div>
  );
}
