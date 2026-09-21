import { requireRole } from "@/lib/auth-utils";
import { TargetsView } from "./TargetsView";

export const dynamic = "force-dynamic";

// R-17 — the sales target register (sheet 8, Requirement #15).
export default async function TargetsPage() {
    await requireRole(["ceo", "admin", "sales_head", "business_head"]);

    return (
        <div className="px-4 sm:px-6 md:px-8 py-6 space-y-5 max-w-[1500px]">
            <header>
                <h1 className="text-2xl font-semibold tracking-tight text-ink">Targets</h1>
                <p className="mt-1 text-sm text-ink-muted">
                    The CEO sets each person&apos;s monthly targets; an admin may add to them but never
                    reduce. An admin or the sales head approves and pushes them, and the person accepts
                    on their performance page — not accepted within 48 hours and the daily Targets
                    Pending mail says so. Progress is measured pro-rata by working day (Mon–Sat, minus
                    holidays). Changing a pushed target sends it back for approval.
                </p>
            </header>
            <TargetsView />
        </div>
    );
}
