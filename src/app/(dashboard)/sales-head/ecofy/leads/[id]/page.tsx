import { EcofyDetailPage } from "@/components/ecofy/pages";
import { ECOFY_MANAGER_ROLES } from "@/lib/ecofy/access";

export const dynamic = "force-dynamic";

export default async function SalesHeadEcofyLeadPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    return <EcofyDetailPage roles={[...ECOFY_MANAGER_ROLES]} id={id} backHref="/sales-head/ecofy/leads" />;
}
