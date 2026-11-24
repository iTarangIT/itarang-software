import { Suspense } from "react";
import { requireRole } from "@/lib/auth-utils";
import { LEADS_PAGE_ROLES } from "@/lib/leads/access";
import { leadHrefFor } from "@/lib/leads/newOwnerNotice";
import { TeamLeadsView, TeamTabs } from "./TeamViews";

export const dynamic = "force-dynamic";

// 24 Nov (CRM item 5): the leads team members own, with each lead's latest
// action and latest comment. A manager sees their direct reports (and their
// own leads); Admin, Sales Head, CEO, Business Head, Sales Manager and Partner see everyone.
export default async function TeamLeadsPage() {
    const user = await requireRole([...LEADS_PAGE_ROLES]);
    return (
        <div className="px-4 sm:px-6 md:px-8 py-6 space-y-5 max-w-[1400px]">
            <header className="space-y-3">
                <div>
                    <h1 className="text-2xl font-semibold tracking-tight text-gray-900">Team leads</h1>
                    <p className="mt-1 text-sm text-gray-500">
                        Leads your team owns, newest action first, with the latest comment on each.
                    </p>
                </div>
                <TeamTabs active="leads" />
            </header>
            <Suspense>
                <TeamLeadsView leadBase={leadHrefFor(user.role, "")} />
            </Suspense>
        </div>
    );
}
