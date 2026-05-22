import { requireRole } from "@/lib/auth-utils";
import { AsmQueueView } from "./_components/AsmQueueView";

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
            <AsmQueueView viewerId={user.id} />
        </div>
    );
}
