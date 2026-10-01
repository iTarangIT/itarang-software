import { EcofyDetailPage } from "@/components/ecofy/pages";

export const dynamic = "force-dynamic";

export default async function MyEcofyLeadPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    return <EcofyDetailPage roles={["inside_sales_rep"]} id={id} backHref="/inside-sales/ecofy-leads" />;
}
