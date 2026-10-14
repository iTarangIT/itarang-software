import { Suspense } from "react";

import { requireRole } from "@/lib/auth-utils";
import { TargetsView } from "./TargetsView";

export const dynamic = "force-dynamic";

// R-17 — the sales target register (sheet 8, Requirement #15; item 3 workflow).
// TargetsView reads ?month= (the notification links carry it), hence Suspense.
export default async function TargetsPage() {
    await requireRole(["ceo", "admin", "sales_head", "business_head"]);

    return (
        <div className="px-4 sm:px-6 md:px-8 py-6 space-y-5 max-w-[1500px]">
            <header>
                <h1 className="text-2xl font-semibold tracking-tight text-ink">Targets</h1>
                <p className="mt-1 text-sm text-ink-muted">
                    The CEO creates each person&apos;s monthly targets and sends them to the Sales Head. The
                    Sales Head reviews them and sends them to the person: leave the Sales Head target empty
                    and the CEO target goes; enter a number — higher or lower — and the Sales Head&apos;s goes
                    instead. Either may add a metric (built-in or custom) or remove one. The person is told
                    by notification and email and accepts or rejects on their performance page; a reject
                    comes back here with their comment, to change and send again. Not accepted within 48
                    hours and the daily Targets Pending mail says so.
                    Changing a sent or accepted target sends it back to the Sales Head&apos;s review.
                    Progress is measured pro-rata by working day (Mon–Sat, minus holidays); a custom
                    metric&apos;s progress is entered by hand.
                </p>
            </header>
            <Suspense fallback={null}>
                <TargetsView />
            </Suspense>
        </div>
    );
}
