import { requireRole } from "@/lib/auth-utils";
import { AdminDashboardView } from "./_components/AdminDashboardView";

export const dynamic = "force-dynamic";

// Admin / Ops-Manager operational hub — BRD §0.11. Becomes the real /admin
// landing page (previously a dead link). Admin + sales_head get the full
// dashboard; CEO sees the same data read-only (BRD §0.12).
export default async function AdminDashboardPage() {
    const user = await requireRole(["admin", "sales_head", "ceo"]);
    const readOnly = user.role === "ceo";

    return (
        <div className="max-w-[1600px] space-y-6 px-6 py-7 md:px-8">
            <header>
                <p className="page-eyebrow">Admin · Part 0</p>
                <h1 className="text-[1.75rem] font-bold tracking-tight text-brand-navy">
                    Operations Dashboard
                </h1>
                <p className="mt-1 text-sm text-ink-muted">
                    {readOnly
                        ? "Read-only overview of the Inside Sales and ASM pipeline."
                        : `Welcome, ${user.name}. Monitor the team, triage exceptions, and run reports.`}
                </p>
            </header>
            <AdminDashboardView readOnly={readOnly} />
        </div>
    );
}
