import { requireRole } from "@/lib/auth-utils";
import { EcofyEpcAgentsPage } from "@/components/ecofy/EcofyEpcAgentsPage";

export const dynamic = "force-dynamic";

// E-307 — EPC agents (Ecofy's EPC partner master) for the ISR.
export default async function InsideSalesEcofyEpcAgentsPage() {
    await requireRole(["inside_sales_rep"]);
    return <EcofyEpcAgentsPage backHref={{ href: "/inside-sales/ecofy-leads", label: "My Ecofy leads" }} />;
}
