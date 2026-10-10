import Link from "next/link";
import { requireRole } from "@/lib/auth-utils";
import { AdminDashboardView } from "../_components/AdminDashboardView";

export const dynamic = "force-dynamic";

// The old Operations Dashboard (BRD §0.11), retired from every menu by tracker
// ID 88: /admin now opens the Sales dashboard (SalesHeadOpsView), the one
// screen Admin, Sales Head and CEO share. Kept at its own route, unlinked from
// the menu, so nothing it showed is lost while the business confirms the new
// screen covers it — delete this route (and AdminDashboardView) once it does.
export default async function OldOperationsDashboardPage() {
    const user = await requireRole(["admin", "sales_head", "ceo"]);
    const readOnly = user.role === "ceo";

    return (
        <div className="max-w-[1600px] space-y-6 px-6 py-7 md:px-8">
            <header>
                <p className="page-eyebrow">Admin · being retired</p>
                <h1 className="text-[1.75rem] font-bold tracking-tight text-brand-navy">
                    Old Operations Dashboard
                </h1>
                <p className="mt-1 text-sm text-ink-muted">
                    Replaced by the{" "}
                    <Link href="/admin" className="font-semibold text-brand-sky hover:underline">
                        Sales dashboard
                    </Link>
                    . Kept here for reference only.
                </p>
            </header>
            <AdminDashboardView readOnly={readOnly} />
        </div>
    );
}
