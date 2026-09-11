import { requireRole } from "@/lib/auth-utils";
import { LeadDetailView } from "@/app/(dashboard)/inside-sales/lead/[id]/_components/LeadDetailView";

export const dynamic = "force-dynamic";

// Lead detail for the partner — the inside-sales view (activity, commercials /
// PI raising, quotation send, hand-off) under the partner's own prefix. Only
// the "Back to queue" target differs.
export default async function PartnerLeadDetailPage({
    params,
}: {
    params: Promise<{ id: string }>;
}) {
    const user = await requireRole(["partner", "admin", "ceo"]);
    const { id } = await params;
    return (
        <LeadDetailView
            leadId={id}
            viewerId={user.id}
            viewerRole={user.role}
            backHref="/partner/leads"
        />
    );
}
