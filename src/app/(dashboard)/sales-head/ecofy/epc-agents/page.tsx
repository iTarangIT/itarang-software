import { requireRole } from "@/lib/auth-utils";
import { ECOFY_MANAGER_ROLES } from "@/lib/ecofy/access";
import { EcofyEpcAgentsPage } from "@/components/ecofy/EcofyEpcAgentsPage";

export const dynamic = "force-dynamic";

// E-307 — EPC agents (Ecofy's EPC partner master), from the Sales Head's Ecofy workspace.
export default async function SalesHeadEcofyEpcAgentsPage() {
    await requireRole([...ECOFY_MANAGER_ROLES]);
    return <EcofyEpcAgentsPage />;
}
