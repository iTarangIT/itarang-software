import { requireRole } from "@/lib/auth-utils";
import { EcofyCalculatorPage } from "@/components/ecofy/EcofyCalculatorPage";

export const dynamic = "force-dynamic";

// E-307 — Ecofy's energy calculator for the ASM.
export default async function AsmEcofyCalculatorPage() {
    await requireRole(["asm"]);
    return <EcofyCalculatorPage backHref={{ href: "/asm/ecofy-leads", label: "My Ecofy leads" }} />;
}
