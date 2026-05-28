import { requireRole } from "@/lib/auth-utils";
import { LeadsInfoView } from "./_components/LeadsInfoView";

export const dynamic = "force-dynamic";

// Admin / Sales Head oversight of every lead managed by Sales Insight reps
// and ASMs.
export default async function LeadsInfoPage() {
    await requireRole(["admin", "sales_head"]);

    return (
        <div className="px-4 sm:px-6 md:px-8 py-6 space-y-5 max-w-[1600px]">
            <header>
                <h1 className="text-2xl font-semibold tracking-tight text-gray-900">
                    Leads Info
                </h1>
                <p className="mt-1 text-sm text-gray-600">
                    Every lead across the Sales Insight and ASM pipeline. Filter
                    by status, owner or region, and open any lead to manage it.
                </p>
            </header>
            <LeadsInfoView />
        </div>
    );
}
