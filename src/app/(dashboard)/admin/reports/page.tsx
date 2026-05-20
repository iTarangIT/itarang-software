import { requireRole } from "@/lib/auth-utils";
import { ReportsView } from "./_components/ReportsView";

export const dynamic = "force-dynamic";

// BRD §0.11 — the 6 pre-canned operational reports. Admin + CEO, read-only.
export default async function AdminReportsPage() {
    await requireRole(["admin", "sales_head", "ceo"]);

    return (
        <div className="px-6 md:px-8 py-6 space-y-5 max-w-[1400px]">
            <header>
                <h1 className="text-2xl font-semibold tracking-tight text-ink">
                    Reports
                </h1>
                <p className="mt-1 text-sm text-ink-muted">
                    Pre-canned operational reports. Pick a report, set a date
                    range, and export to CSV.
                </p>
            </header>
            <ReportsView />
        </div>
    );
}
