import { EcofyListPage } from "@/components/ecofy/pages";
import { ECOFY_MANAGER_ROLES } from "@/lib/ecofy/access";

export const dynamic = "force-dynamic";

// E-307 — every Ecofy lead in the CRM; select to assign / reassign.
export default async function EcofyAllLeadsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
    const sp = await searchParams;
    const all = sp.view === "all";
    return (
        <EcofyListPage
            roles={[...ECOFY_MANAGER_ROLES]}
            title="Ecofy — All leads"
            subtitle="Every lead handed over by Ecofy. Hot first, then the longest waiting."
            hrefBase="/sales-head/ecofy/leads"
            view={all ? "all" : "open"}
            searchParams={searchParams}
            emptyText={all ? "No Ecofy leads yet." : "No open Ecofy leads."}
            tabs={[
                { label: "Open", href: "/sales-head/ecofy/leads", active: !all },
                { label: "All (incl. returned & closed)", href: "/sales-head/ecofy/leads?view=all", active: all },
            ]}
        />
    );
}
