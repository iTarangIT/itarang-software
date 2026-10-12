// ID 169 (10 Oct) — a pending Undo Mark Won request is moot once the lead
// leaves Won (onboarding approved, a drop-out decision, …). Nothing ever
// cleared it, so the Sales Head's "Undo Mark Won requests waiting" tile stayed
// inflated and the lead page (which shows the control only on a Won lead) gave
// no way to clear it.
//
// Its own module, not wonUndo.ts: writeTouchpoint calls it, and wonUndo.ts
// imports writeTouchpoint.

import { sql } from "drizzle-orm";
import type { db } from "@/lib/db";

type Exec = Pick<typeof db, "execute">;

/** Cancels the lead's pending request, inside the caller's transaction. A DB without E-333 is skipped. */
export async function cancelPendingWonUndo(ex: Exec, leadId: string, why: string): Promise<void> {
    const has = (await ex.execute<{ ok: boolean }>(sql`
        SELECT to_regclass('public.lead_won_undo_requests') IS NOT NULL AS ok
    `)) as unknown as Array<{ ok: boolean }>;
    if (!has[0]?.ok) return;
    await ex.execute(sql`
        UPDATE lead_won_undo_requests
           SET status = 'cancelled', decided_at = NOW(), decision_note = ${why}
         WHERE dealer_lead_id = ${leadId} AND status = 'pending'
    `);
}
