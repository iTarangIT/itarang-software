// One-off companion to the 14 Nov 2026 "Connected sticks" rule
// (campaignTracker.recordAttemptOutcome + retryPolicy.lastConversation).
//
// Before it, a redial that did not connect overwrote a row on which the dealer
// had already SPOKEN: B.N. Enterprises talked on dial 2, the 15-min "Dropped
// mid-call" redial failed with SIP 480, and the row read "No Response" with a
// next-day redial booked. This puts such rows back to Connected:
//   status = 'completed', call_outcome / bolna_call_id = the last conversation,
//   next_attempt_at = NULL (no more AI redials; the lead is the rep's).
// attempt_history is left as it is — it is the record of every dial.
//
//   node --import tsx --env-file=.env.local scripts/fix-connected-status.ts           dry run
//   node --import tsx --env-file=.env.local scripts/fix-connected-status.ts --apply   write
//
// SAFE TO RE-RUN: a fixed row is 'completed' and no longer matches; each
// UPDATE is guarded on the status it read. Prints counts and ids only.

import { sql } from "drizzle-orm";
import { db } from "../src/lib/db";
import { lastConversation } from "../src/lib/ai-dialer/retryPolicy";
import { syncCampaignCounters } from "../src/lib/queue/campaignTracker";

const APPLY = process.argv.includes("--apply");

type Row = {
    id: string;
    campaign_id: string;
    status: string;
    next_attempt_at: string | null;
    attempt_history: unknown;
};

function rowsOf<T>(result: unknown): T[] {
    return (result as { rows?: T[] }).rows ?? (result as T[]);
}

async function main() {
    const rows = rowsOf<Row>(
        await db.execute(sql`
            SELECT id, campaign_id, status, next_attempt_at, attempt_history
              FROM dialer_campaign_leads
             WHERE status NOT IN ('completed', 'pending', 'calling', 'skipped')
               AND jsonb_typeof(attempt_history) = 'array'
               AND EXISTS (SELECT 1 FROM jsonb_array_elements(attempt_history) e
                            WHERE e->>'status' = 'completed')
        `),
    );

    console.log(`${APPLY ? "APPLY" : "DRY RUN"} — ${rows.length} row(s) where the dealer spoke but the row is not Connected`);
    for (const r of rows) {
        console.log(`  ${r.id}  campaign ${r.campaign_id}  ${r.status}${r.next_attempt_at ? "  (redial booked)" : ""}`);
    }
    if (!APPLY || rows.length === 0) return;

    let fixed = 0;
    const campaigns = new Set<string>();
    for (const r of rows) {
        const spoke = lastConversation(r.attempt_history as Array<{ status?: string }>);
        if (!spoke) continue;
        const res = rowsOf<{ id: string }>(
            await db.execute(sql`
                UPDATE dialer_campaign_leads
                   SET status = 'completed',
                       call_outcome = ${spoke.outcome},
                       bolna_call_id = ${spoke.call_id},
                       next_attempt_at = NULL
                 WHERE id = ${r.id} AND status = ${r.status}
                RETURNING id
            `),
        );
        if (res.length > 0) {
            fixed++;
            campaigns.add(r.campaign_id);
        }
    }
    for (const id of campaigns) await syncCampaignCounters(id);
    console.log(`fixed ${fixed} row(s); re-synced counters on ${campaigns.size} campaign(s)`);
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error(err instanceof Error ? (err.cause ?? err.message) : err);
        process.exit(1);
    });
