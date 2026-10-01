import { requireRole } from "@/lib/auth-utils";
import { EcofyCalculatorPage } from "@/components/ecofy/EcofyCalculatorPage";

export const dynamic = "force-dynamic";

// E-307 — Ecofy's energy calculator for the ISR.
export default async function InsideSalesEcofyCalculatorPage() {
    await requireRole(["inside_sales_rep"]);
    return <EcofyCalculatorPage backHref={{ href: "/inside-sales/ecofy-leads", label: "My Ecofy leads" }} />;
}
