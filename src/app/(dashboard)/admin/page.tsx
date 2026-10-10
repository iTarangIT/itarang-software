import { Suspense } from "react";
import { requireRole } from "@/lib/auth-utils";
import { SalesHeadOpsView } from "@/components/dashboard/sales/SalesHeadOpsView";

export const dynamic = "force-dynamic";

// Tracker ID 88 — Admin lands on the Sales dashboard, the same screen as
// /sales-head and /admin/reports/sales-dashboard ("Admin and Sales Head see
// the same", 29 Sep). The old Operations Dashboard moved to
// /admin/ops-dashboard and is off every menu. Filters live in the URL
// (useSearchParams), hence the Suspense boundary.
export default async function AdminDashboardPage() {
    await requireRole(["admin", "sales_head", "ceo"]);

    return (
        <Suspense fallback={<div className="p-8 text-center text-sm text-ink-muted">Loading…</div>}>
            <SalesHeadOpsView />
        </Suspense>
    );
}
