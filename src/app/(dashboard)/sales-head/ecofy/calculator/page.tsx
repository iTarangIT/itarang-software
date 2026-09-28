import { requireRole } from "@/lib/auth-utils";
import { ECOFY_MANAGER_ROLES } from "@/lib/ecofy/access";
import { EcofyCalculatorPage } from "@/components/ecofy/EcofyCalculatorPage";

export const dynamic = "force-dynamic";

// E-307 — Ecofy's energy calculator, from the Sales Head's Ecofy workspace.
export default async function SalesHeadEcofyCalculatorPage() {
    await requireRole([...ECOFY_MANAGER_ROLES]);
    return <EcofyCalculatorPage />;
}
