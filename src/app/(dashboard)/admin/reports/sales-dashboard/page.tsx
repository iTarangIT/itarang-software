import { requireRole } from "@/lib/auth-utils";
import { SalesDashboardView } from "@/components/dashboard/sales/SalesDashboardView";

export const dynamic = "force-dynamic";

// B7 — the team-wide sales dashboard: what happened yesterday, what is planned,
// hot / warm / cold with ageing, and one line per SPOC. Same role set as the
// API it reads (/api/admin/reports/sales-dashboard). Filters live in the URL.
export default async function AdminSalesDashboardPage() {
    await requireRole(["admin", "ceo", "sales_head", "business_head", "partner"]);

    return (
        <div className="px-4 sm:px-6 md:px-8 py-6 space-y-5 max-w-[1500px]">
            <header>
                <h1 className="text-2xl font-semibold tracking-tight text-ink">
                    Sales Dashboard
                </h1>
                <p className="mt-1 text-sm text-ink-muted">
                    Visits and calls by day, week or month, hot / warm / cold leads by
                    age, and how each SPOC is doing. Pick a SPOC, or click a row in the
                    table, to see one person&apos;s numbers. The address bar carries the
                    filters, so the view can be shared.
                </p>
            </header>
            <SalesDashboardView mode="admin" />
        </div>
    );
}
