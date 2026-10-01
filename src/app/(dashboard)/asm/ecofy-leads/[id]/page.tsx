import { EcofyDetailPage } from "@/components/ecofy/pages";

export const dynamic = "force-dynamic";

export default async function MyEcofyLeadPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    return <EcofyDetailPage roles={["asm"]} id={id} backHref="/asm/ecofy-leads" />;
}
