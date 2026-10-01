import { requireRole } from "@/lib/auth-utils";
import { CAMPAIGN_MANAGE_ROLES } from "@/lib/leads/campaignAccess";
import { CampaignsView } from "./CampaignsView";

export const dynamic = "force-dynamic";

// Tracker ID 81 — the acquisition campaign register.
export default async function AcquisitionCampaignsPage() {
    await requireRole([...CAMPAIGN_MANAGE_ROLES]);

    return (
        <div className="px-4 sm:px-6 md:px-8 py-6 space-y-5 max-w-[1500px]">
            <header>
                <h1 className="text-2xl font-semibold tracking-tight text-ink">Acquisition Campaigns</h1>
                <p className="mt-1 text-sm text-ink-muted">
                    The event, ad or list a lead came in on — the third source tag beside Entered via and
                    Found via. Reps pick a campaign when they create or upload leads; a Trade event or
                    Digital ad lead cannot be created without one. Every bulk upload, scrape run and
                    AI-dialer list also gets a campaign of its own. These are not dialler campaigns: they
                    say where a lead came from, not who calls it.
                </p>
            </header>
            <CampaignsView />
        </div>
    );
}
