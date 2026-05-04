import NbfcMasterDetailsForm from "@/components/admin/nbfc/NbfcMasterDetailsForm";
import { PageShell, buildNbfcSteps } from "@/components/layout/PageShell";

export const dynamic = "force-dynamic";

export default async function AdminNbfcEditPage({
  params,
}: {
  params: Promise<{ nbfcId: string }>;
}) {
  const { nbfcId } = await params;
  return (
    <PageShell
      eyebrow="Edit NBFC"
      title="Master details"
      subtitle="Edits to a draft are saved in place. Once an NBFC is approved or active, only contact and grievance fields are mutable."
      breadcrumb={[
        { label: "Admin", href: "/admin" },
        { label: "NBFC", href: "/admin/nbfc" },
        { label: nbfcId },
        { label: "Edit" },
      ]}
      steps={buildNbfcSteps({ active: "master" })}
    >
      <NbfcMasterDetailsForm mode="edit" nbfcId={nbfcId} />
    </PageShell>
  );
}
