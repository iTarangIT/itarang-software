import { requireRole } from "@/lib/auth-utils";
import { SalesDashboardView } from "@/components/dashboard/sales/SalesDashboardView";

export const dynamic = "force-dynamic";

// B6 — an ASM's own numbers. The API behind this (/api/asm/reports/sales-dashboard)
// pins the rep to the session, so there is no rep picker and no per-rep table.
export default async function AsmPerformancePage() {
    const user = await requireRole(["asm"]);

    return (
        <div className="px-4 sm:px-6 md:px-8 py-6 space-y-5 max-w-[1400px]">
            <header>
                <h1 className="text-2xl font-semibold tracking-tight text-gray-900">
                    My Performance
                </h1>
                <p className="mt-1 text-sm text-gray-600">
                    {user.name}, here are your visits, calls and open hot / warm / cold
                    leads. Yesterday, today, this week, and the trend over the range you pick.
                </p>
            </header>
            <SalesDashboardView mode="asm" />
        </div>
    );
}
