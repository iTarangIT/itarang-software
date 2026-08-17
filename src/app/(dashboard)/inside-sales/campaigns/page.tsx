import { requireRole } from "@/lib/auth-utils";
import { CampaignsTable } from "@/components/leads/campaigns-table";

export const dynamic = "force-dynamic";

// AI-dialer campaign history for the Inside Sales Rep.
//
// The rep works the leads these campaigns produced, so the call record behind a
// lead they are about to ring should not live only on the admin console. This
// mounts the SAME CampaignsTable the admin sees (`/leads?tab=campaigns`) under
// this dashboard's own prefix, which is what keeps middleware's role gate on it
// — /inside-sales/* is a roleDashboards prefix, /leads/* is not.
//
// Deliberately unfiltered: the rep sees every campaign, as agreed. There is no
// per-assignee scoping to apply anyway — neither dialer_campaigns nor
// dialer_campaign_leads carries an owner column.
export default async function InsideSalesCampaignsPage() {
    const user = await requireRole([
        "inside_sales_rep",
        "admin",
        "ceo",
        "sales_manager",
        "sales_head",
        "business_head",
    ]);

    return (
        <div className="px-6 md:px-8 py-6 space-y-5 max-w-[1600px]">
            <header>
                <h1 className="text-2xl font-semibold tracking-tight text-gray-900">
                    Campaigns
                </h1>
                <p className="mt-1 text-sm text-gray-600">
                    Welcome, {user.name}. Open a campaign to see its leads, call outcomes and
                    transcripts.
                </p>
            </header>
            <CampaignsTable basePath="/inside-sales/campaigns" />
        </div>
    );
}
