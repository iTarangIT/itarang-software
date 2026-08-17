import { requireRole } from "@/lib/auth-utils";
import { CampaignsTable } from "@/components/leads/campaigns-table";

export const dynamic = "force-dynamic";

// AI-dialer campaign history for the ASM — the twin of
// /inside-sales/campaigns. Same table, same lack of filtering; only the role
// gate and the basePath differ, because /asm/* is what middleware gates to the
// asm role.
export default async function AsmCampaignsPage() {
    const user = await requireRole([
        "asm",
        "admin",
        "ceo",
        "sales_manager",
        "sales_head",
        "business_head",
    ]);

    return (
        <div className="px-4 sm:px-6 md:px-8 py-6 space-y-5 max-w-[1600px]">
            <header>
                <h1 className="text-2xl font-semibold tracking-tight text-gray-900">
                    Campaigns
                </h1>
                <p className="mt-1 text-sm text-gray-600">
                    Welcome, {user.name}. Open a campaign to see its leads, call outcomes and
                    transcripts before you visit.
                </p>
            </header>
            <CampaignsTable basePath="/asm/campaigns" />
        </div>
    );
}
