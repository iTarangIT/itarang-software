import { requireRole } from "@/lib/auth-utils";
import { MergeRequestsView } from "./_components/MergeRequestsView";

export const dynamic = "force-dynamic";

// BRD §0.4 — phone-collision + address-mismatch merge requests. Resolution is
// admin-only; CEO views read-only.
export default async function AdminMergeRequestsPage() {
    const user = await requireRole(["admin", "sales_head", "ceo"]);

    return (
        <div className="px-6 md:px-8 py-6 space-y-5 max-w-[1400px]">
            <header>
                <h1 className="text-2xl font-semibold tracking-tight text-ink">
                    Merge Requests
                </h1>
                <p className="mt-1 text-sm text-ink-muted">
                    Review phone collisions and address mismatches. V1 records
                    the decision — physical merges happen by inspection.
                </p>
            </header>
            <MergeRequestsView viewerRole={user.role} />
        </div>
    );
}
