import NbfcMasterDetailsForm from "@/components/admin/nbfc/NbfcMasterDetailsForm";
import { PageShell, buildNbfcSteps } from "@/components/layout/PageShell";

export const dynamic = "force-dynamic";

export default function AdminNbfcNewPage() {
  return (
    <PageShell
      eyebrow="NBFC Onboarding"
      title="Create NBFC partner"
      subtitle="Capture RBI registration, registered address, primary contacts, and grievance officer details. Submission hands the NBFC off to CEO Sanchit for review."
      breadcrumb={[
        { label: "Admin", href: "/admin" },
        { label: "NBFC", href: "/admin/nbfc" },
        { label: "New" },
      ]}
      steps={buildNbfcSteps({ active: "master" })}
    >
      <NbfcMasterDetailsForm mode="create" />
    </PageShell>
  );
}
