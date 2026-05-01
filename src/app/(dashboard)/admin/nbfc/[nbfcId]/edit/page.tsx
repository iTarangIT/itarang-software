import NbfcMasterDetailsForm from "@/components/admin/nbfc/NbfcMasterDetailsForm";

export const dynamic = "force-dynamic";

export default async function AdminNbfcEditPage({
  params,
}: {
  params: Promise<{ nbfcId: string }>;
}) {
  const { nbfcId } = await params;
  return (
    <div className="p-6">
      <h1 className="text-xl font-semibold mb-4">Edit NBFC partner</h1>
      <NbfcMasterDetailsForm mode="edit" nbfcId={nbfcId} />
    </div>
  );
}
