import { requireRole } from "@/lib/auth-utils";
import { SalesDashboardView } from "@/components/dashboard/sales/SalesDashboardView";
import { MyTargetsCard } from "@/components/targets/MyTargetsCard";

export const dynamic = "force-dynamic";

// B6 — an inside-sales rep's own numbers. The API behind this
// (/api/inside-sales/reports/sales-dashboard) pins the rep to the session, so
// there is no rep picker and no per-rep table.
export default async function InsideSalesPerformancePage() {
    const user = await requireRole(["inside_sales_rep"]);

    return (
        <div className="px-6 md:px-8 py-6 space-y-5 max-w-[1400px]">
            <header>
                <h1 className="text-2xl font-semibold tracking-tight text-gray-900">
                    My Performance
                </h1>
                <p className="mt-1 text-sm text-gray-600">
                    {user.name}, here are your calls, visits and open hot / warm / cold
                    leads. Yesterday, today, this week, and the trend over the range you pick.
                </p>
            </header>
            {/* R-17 — accept pushed targets; actual vs target this month. */}
            <MyTargetsCard />
            <SalesDashboardView mode="isr" />
        </div>
    );
}
