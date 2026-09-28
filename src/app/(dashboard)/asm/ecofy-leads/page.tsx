import { EcofyListPage } from "@/components/ecofy/pages";

export const dynamic = "force-dynamic";

// E-307 — Ecofy leads the Sales Head assigned to me, in the My Visits layout.
export default function MyEcofyLeadsPage() {
    return (
        <EcofyListPage
            roles={["asm"]}
            title="Ecofy Leads"
            subtitle="Solar / storage leads from Ecofy assigned to you by the Sales Head. Call, meet, assess and send the offer from each lead."
            hrefBase="/asm/ecofy-leads"
            initialTab="open"
        />
    );
}
