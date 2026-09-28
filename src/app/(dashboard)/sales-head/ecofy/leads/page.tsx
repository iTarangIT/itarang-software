import { EcofyListPage } from "@/components/ecofy/pages";
import { ECOFY_MANAGER_ROLES } from "@/lib/ecofy/access";

export const dynamic = "force-dynamic";

// E-307 — every Ecofy lead in the CRM; select to assign / reassign.
export default function EcofyAllLeadsPage() {
    return (
        <EcofyListPage
            roles={[...ECOFY_MANAGER_ROLES]}
            title="Ecofy — Leads"
            subtitle="Every lead handed over by Ecofy. Hot first, then the longest waiting. Select leads to assign or reassign them."
            hrefBase="/sales-head/ecofy/leads"
            initialTab="open"
        />
    );
}
