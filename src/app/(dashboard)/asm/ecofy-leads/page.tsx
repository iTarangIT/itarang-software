import { EcofyListPage } from "@/components/ecofy/pages";

export const dynamic = "force-dynamic";

// E-307 — Ecofy leads the Sales Head assigned to me.
export default async function MyEcofyLeadsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
    const sp = await searchParams;
    const all = sp.view === "all";
    return (
        <EcofyListPage
            roles={["asm"]}
            title="My Ecofy leads"
            subtitle="Solar / storage leads from Ecofy assigned to you by the Sales Head. Call, meet, assess and send the offer from each lead."
            hrefBase="/asm/ecofy-leads"
            view={all ? "all" : "open"}
            searchParams={searchParams}
            emptyText="No Ecofy leads assigned to you yet."
            tabs={[
                { label: "Open", href: "/asm/ecofy-leads", active: !all },
                { label: "All", href: "/asm/ecofy-leads?view=all", active: all },
            ]}
        />
    );
}
