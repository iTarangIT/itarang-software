import { requireRole } from "@/lib/auth-utils";
import { EcofyMyLeadsCard } from "@/components/ecofy/pages";
import { AsmQueueView } from "./_components/AsmQueueView";
import { AsmPerformanceStrip } from "@/components/dashboard/sales/AsmPerformanceStrip";
import { exportsOwnLeadsOnly } from "@/lib/leads/access";
import { getTeamPeople } from "@/lib/users/team";

export const dynamic = "force-dynamic";

// ASM workspace — replaces the Module 0 stub. Real queue + tabs in the client
// component below; this server page just gates the role and threads the user
// id down for the "you" indicators and owner-only action enablement.
export default async function AsmQueuePage() {
    const user = await requireRole([
        "asm",
        "admin",
        "ceo",
        "sales_manager",
        "sales_head",
        "business_head",
    ]);
    // ID 199: a manager's direct reports, for the Team member pick.
    const teamPeople = exportsOwnLeadsOnly(user.role) ? await getTeamPeople(user.id) : [];

    return (
        <div className="px-4 sm:px-6 md:px-8 py-6 space-y-5 max-w-[1600px]">
            <header className="flex items-start justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-semibold tracking-tight text-gray-900">
                        Field Work — My Visits
                    </h1>
                    <p className="mt-1 text-sm text-gray-600">
                        Welcome, {user.name}. Track your handed-off leads, schedule visits, and close on the ground.
                    </p>
                </div>
            </header>
            {/* B7 — the rep's own visits / calls / hot-warm-cold at a glance. */}
            <AsmPerformanceStrip />
            {/* E-307 — Ecofy leads the Sales Head assigned to this rep. */}
            <EcofyMyLeadsCard href="/asm/ecofy-leads" />
            <AsmQueueView viewerId={user.id} viewerRole={user.role} teamPeople={teamPeople} />
        </div>
    );
}
