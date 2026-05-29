import { requireRole } from "@/lib/auth-utils";
import { LeadDetailView } from "./_components/LeadDetailView";

export const dynamic = "force-dynamic";

// Server entry — gates the role, then hands the id to the client view which
// owns the useQuery + modal state. The initial paint shows a skeleton while
// the bundle loads; SSR-fetch was tempting but complicates auth-cookie
// forwarding for marginal gain on this rare-visit page.
export default async function LeadDetailPage({
    params,
}: {
    params: Promise<{ id: string }>;
}) {
    const user = await requireRole([
        "inside_sales_rep",
        "asm",
        "admin",
        "ceo",
        "sales_manager",
        "sales_head",
        "business_head",
    ]);
    const { id } = await params;
    return <LeadDetailView leadId={id} viewerId={user.id} viewerRole={user.role} />;
}
