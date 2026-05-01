import NbfcMasterDetailsForm from "@/components/admin/nbfc/NbfcMasterDetailsForm";

export const dynamic = "force-dynamic";

export default function AdminNbfcNewPage() {
  return (
    <div className="p-6">
      <h1 className="text-xl font-semibold mb-4">Create NBFC partner</h1>
      <NbfcMasterDetailsForm mode="create" />
    </div>
  );
}
