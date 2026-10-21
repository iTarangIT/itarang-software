import { requireRole } from "@/lib/auth-utils";
import { getTimeLimits } from "@/lib/timeLimits/store";
import { NeedsAttentionView } from "./NeedsAttentionView";

export const dynamic = "force-dynamic";

// R-15 — the manager's needs-attention list (Requirement #6 point 4). Same role
// set as the API it reads and the bulk-lead route it reassigns through.
export default async function NeedsAttentionPage() {
    await requireRole(["admin", "sales_head", "ceo", "partner"]);
    // ID 85 — the idle limits in force today (needsAttention.ts reads the same).
    const limits = await getTimeLimits();

    return (
        <div className="px-4 sm:px-6 md:px-8 py-6 space-y-5 max-w-[1400px]">
            <header>
                <h1 className="text-2xl font-semibold tracking-tight text-ink">Needs Attention</h1>
                <p className="mt-1 text-sm text-ink-muted">
                    Every open lead someone is holding but not working, oldest first. The idle
                    count is in working days from the latest of: the last work (a call, visit or
                    status change — claiming or commenting is not work), the day the holder got
                    the lead (a handover starts the count again for the new holder) and a
                    follow-up date once it has passed. A follow-up still ahead keeps a lead off
                    this list; one more than 30 days ahead is ignored. Listed from{" "}
                    {limits.idle_cc} idle working days for inside sales, {limits.idle_asm} for
                    ASMs; rows turn amber at {limits.stale_yellow}, red at {limits.stale_red} and dark red at{" "}
                    {limits.stale_critical} working days (Admin › Time limits).
                    The &ldquo;Counted from&rdquo; column says which date the count runs from.
                    Reassign straight from the row.
                </p>
            </header>
            <NeedsAttentionView />
        </div>
    );
}
