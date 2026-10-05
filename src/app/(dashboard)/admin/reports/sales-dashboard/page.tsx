import { Suspense } from "react";
import { requireRole } from "@/lib/auth-utils";
import { SalesHeadOpsView } from "@/components/dashboard/sales/SalesHeadOpsView";

export const dynamic = "force-dynamic";

// The team-wide sales screen: what needs action, each person against target,
// where open leads sit, accounts by owner and why leads were lost. It is the
// same Sales Head operations view as /sales-head, here for the roles that
// cannot open that route. Same role set as the API it reads
// (/api/admin/reports/sales-dashboard). Filters live in the URL.
export default async function AdminSalesDashboardPage() {
    await requireRole(["admin", "ceo", "sales_head", "business_head", "partner"]);

    return (
        <Suspense fallback={<div className="p-8 text-center text-sm text-ink-muted">Loading…</div>}>
            <SalesHeadOpsView />
        </Suspense>
    );
}
