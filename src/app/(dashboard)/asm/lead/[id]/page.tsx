import { requireRole } from "@/lib/auth-utils";
import { AsmLeadDetailView } from "./_components/AsmLeadDetailView";

export const dynamic = "force-dynamic";

// Server entry — gates the role, hands the id to the client view which owns
// the useQuery, modal state, and the visit → next_action chain.
export default async function AsmLeadDetailPage({
    params,
}: {
    params: Promise<{ id: string }>;
}) {
    const user = await requireRole([
        "asm",
        "admin",
        "ceo",
        "sales_manager",
        "sales_head",
        "business_head",
        "inside_sales_rep",
    ]);
    const { id } = await params;
    return <AsmLeadDetailView leadId={id} viewerId={user.id} viewerRole={user.role} />;
}
