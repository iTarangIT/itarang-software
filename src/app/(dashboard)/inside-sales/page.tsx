import { requireRole } from "@/lib/auth-utils";
import { QueueView } from "./_components/QueueView";

export const dynamic = "force-dynamic";

// Inside Sales Rep workspace — replaces the Module 0 stub. The actual queue
// table + tabs live in the client component below; this server page just
// gates the role and passes the viewer id down for "you" indicators and
// owner-only action enablement.
export default async function InsideSalesQueuePage() {
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
            <header className="flex items-start justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-semibold tracking-tight text-gray-900">
                        Inside Sales — My Workspace
                    </h1>
                    <p className="mt-1 text-sm text-gray-600">
                        Welcome, {user.name}. Work AI-qualified dealer leads through engagement, commercials, and handoff.
                    </p>
                </div>
            </header>
            <QueueView viewerId={user.id} />
        </div>
    );
}
