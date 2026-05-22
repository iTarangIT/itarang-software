import { requireRole } from "@/lib/auth-utils";
import { EscalationDetailView } from "./_components/EscalationDetailView";

export const dynamic = "force-dynamic";

// BRD §0.6 — escalation resolution thread. Admin executes; CEO views only.
export default async function AdminEscalationDetailPage({
    params,
}: {
    params: Promise<{ id: string }>;
}) {
    const user = await requireRole(["admin", "sales_head", "ceo"]);
    const { id } = await params;
    return <EscalationDetailView escalationId={id} viewerRole={user.role} />;
}
