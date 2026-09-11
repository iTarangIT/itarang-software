import { requireRole } from "@/lib/auth-utils";
import { CampaignsTable } from "@/components/leads/campaigns-table";
import { INTENT_REVIEW_ROLES } from "@/lib/leads/access";

export const dynamic = "force-dynamic";

// AI-dialer campaign history for the partner — the twin of
// /sales-head/campaigns, /asm/campaigns and /inside-sales/campaigns. Same
// table, same drawer; only the basePath differs, because middleware gates
// each of those prefixes to its own role.
export default async function PartnerCampaignsPage() {
    const user = await requireRole([...INTENT_REVIEW_ROLES]);

    return (
        <div className="px-4 sm:px-6 md:px-8 py-6 space-y-5 max-w-[1600px]">
            <header>
                <h1 className="text-2xl font-semibold tracking-tight text-gray-900">
                    AI Campaigns
                </h1>
                <p className="mt-1 text-sm text-gray-600">
                    Welcome, {user.name}. Open a campaign to review its calls — listen to a
                    recording, read the transcript, and correct the intent band where the AI
                    got it wrong.
                </p>
            </header>
            <CampaignsTable basePath="/partner/campaigns" />
        </div>
    );
}
