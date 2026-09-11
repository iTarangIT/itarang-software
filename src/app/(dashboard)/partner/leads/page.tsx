import { requireRole } from "@/lib/auth-utils";
import { QueueView } from "@/app/(dashboard)/inside-sales/_components/QueueView";

export const dynamic = "force-dynamic";

// The partner's working queue — the inside-sales workspace mounted under the
// partner's own prefix. Same table, tabs and modals; only the URL the view
// writes to and the lead-detail route it opens differ, because middleware
// gates /inside-sales/* to that role and the sidebar infers the role from the
// path (the ASM twin at /asm exists for the same reason).
//
// A lead the partner creates here is self-assigned (see
// api/inside-sales/lead/create), so it lands in My Open, not the claim pool.
export default async function PartnerLeadsPage() {
    const user = await requireRole(["partner", "admin", "ceo"]);

    return (
        <div className="px-6 md:px-8 py-6 space-y-5 max-w-[1600px]">
            <header className="flex items-start justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-semibold tracking-tight text-gray-900">
                        My Leads
                    </h1>
                    <p className="mt-1 text-sm text-gray-600">
                        Welcome, {user.name}. Work your dealer leads through engagement, raise a PI, and hand off.
                    </p>
                </div>
            </header>
            <QueueView
                viewerId={user.id}
                viewerRole={user.role}
                basePath="/partner/leads"
                leadHrefBase="/partner/lead"
            />
        </div>
    );
}
