import { Suspense } from "react";
import { requireRole } from "@/lib/auth-utils";
import { LEADS_PAGE_ROLES } from "@/lib/leads/access";
import { leadHrefFor } from "@/lib/leads/newOwnerNotice";
import { TeamTabs, TeamVisitsView } from "../TeamViews";

export const dynamic = "force-dynamic";

// 24 Nov (CRM item 7): scheduled and completed visits as two separate lists,
// each with its own date range and a CSV download.
export default async function TeamVisitsPage() {
    const user = await requireRole([...LEADS_PAGE_ROLES]);
    return (
        <div className="px-4 sm:px-6 md:px-8 py-6 space-y-5 max-w-[1400px]">
            <header className="space-y-3">
                <div>
                    <h1 className="text-2xl font-semibold tracking-tight text-gray-900">Team visits</h1>
                    <p className="mt-1 text-sm text-gray-500">
                        Scheduled visits by the day they were planned for; completed visits by the day they happened.
                    </p>
                </div>
                <TeamTabs active="visits" />
            </header>
            <Suspense>
                <TeamVisitsView leadBase={leadHrefFor(user.role, "")} />
            </Suspense>
        </div>
    );
}
