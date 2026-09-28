import { requireRole } from "@/lib/auth-utils";
import { ECOFY_MANAGER_ROLES } from "@/lib/ecofy/access";
import { EcofyCalculatorDesignerPage } from "@/components/ecofy/EcofyCalculatorDesignerPage";

export const dynamic = "force-dynamic";

// Calculator designer (Ecofy M08, CONFLICTS #31): the release editor that used
// to live at sandbox-ecofy.itarang.com/calculator/designer, now in the CRM.
// Sales Head / CEO only — iTarang-Admin work in Ecofy's role matrix.
export default async function SalesHeadEcofyCalculatorDesignerPage() {
    await requireRole([...ECOFY_MANAGER_ROLES]);
    return <EcofyCalculatorDesignerPage />;
}
