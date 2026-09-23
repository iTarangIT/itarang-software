import { requireRole } from "@/lib/auth-utils";
import { NeedsAttentionView } from "./NeedsAttentionView";

export const dynamic = "force-dynamic";

// R-15 — the manager's needs-attention list (Requirement #6 point 4). Same role
// set as the API it reads and the bulk-lead route it reassigns through.
export default async function NeedsAttentionPage() {
    await requireRole(["admin", "sales_head", "ceo", "partner"]);

    return (
        <div className="px-4 sm:px-6 md:px-8 py-6 space-y-5 max-w-[1400px]">
            <header>
                <h1 className="text-2xl font-semibold tracking-tight text-ink">Needs Attention</h1>
                <p className="mt-1 text-sm text-ink-muted">
                    Every open lead someone is holding but not working, oldest first. Only a
                    call, visit or status change counts as work — assigning, claiming or
                    commenting does not. Listed from 5 idle working days for inside sales, 7 for
                    ASMs. Reassign straight from the row.
                </p>
            </header>
            <NeedsAttentionView />
        </div>
    );
}
