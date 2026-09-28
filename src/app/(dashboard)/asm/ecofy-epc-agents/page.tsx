import { requireRole } from "@/lib/auth-utils";
import { EcofyEpcAgentsPage } from "@/components/ecofy/EcofyEpcAgentsPage";

export const dynamic = "force-dynamic";

// E-307 — EPC agents (Ecofy's EPC partner master) for the ASM.
export default async function AsmEcofyEpcAgentsPage() {
    await requireRole(["asm"]);
    return <EcofyEpcAgentsPage backHref={{ href: "/asm/ecofy-leads", label: "My Ecofy leads" }} />;
}
