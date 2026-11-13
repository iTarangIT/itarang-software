// Book automatic retries for unreached leads in campaigns that never got them —
// the one-off companion to the 13 Nov 2026 retry rule ("call every lead except
// completed and wrong number", src/lib/ai-dialer/retryPolicy.ts).
//
// Two kinds of row never had a retry booked and the new rule alone will not
// book one, because a retry is only planned when an attempt ENDS:
//   - campaigns created before E-315 (max_retries NULL), whose rows finished
//     before NULL started meaning DEFAULT_MAX_RETRIES;
//   - rows that ended as switchboard / stopped_by_user / a non-retryable
//     failure under the old rule.
//
//   node --import tsx --env-file=.env.local scripts/book-campaign-retries.ts
//       dry run: per-campaign counts, writes nothing
//   … --apply                 write next_attempt_at, re-open completed campaigns
//   … --campaign <id>         limit to one campaign
//   … --since YYYY-MM-DD      only campaigns created on/after this date
//   … --include-stopped       also campaigns a user stopped (left out by default)
//
// Which rows: the NEWEST campaign row per lead (an older campaign never rings a
// lead a newer one already dialled), status finished and isAutoRetryable(),
// no retry already booked, dials left under the campaign's budget. The retry
// is booked at the next open minute of the campaign's window (org default hours
// for 'now' campaigns), narrowed to dialler hours. The dial-time checks in
// advanceCampaign still skip a lead that has since been reached by the AI or
// picked up by sales.
//
// SAFE TO RE-RUN: a booked row has next_attempt_at set and is not picked again;
// every UPDATE is guarded on the status and NULL next_attempt_at it read.
// Prints counts and ids only.

import { sql } from "drizzle-orm";
import { db } from "../src/lib/db";
import {
    clampIntoWindow,
    effectiveMaxRetries,
    isAutoRetryable,
    withinDialerHours,
    type RetryWindow,
} from "../src/lib/ai-dialer/retryPolicy";
import { defaultRetryWindow } from "../src/lib/queue/campaignTracker";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const INCLUDE_STOPPED = args.includes("--include-stopped");
const argOf = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const campaignArg = argOf("--campaign");
const sinceArg = argOf("--since");

type Row = {
    id: string;
    campaign_id: string;
    campaign_name: string | null;
    campaign_status: string;
    status: string;
    call_outcome: string | null;
    attempt_count: number | null;
    max_retries: number | null;
    schedule_mode: string | null;
    window_start: string | null;
    window_end: string | null;
    window_days: unknown;
};

function rowsOf<T>(result: unknown): T[] {
    return (result as { rows?: T[] }).rows ?? (result as T[]);
}

async function main() {
    const campaignStatuses = ["running", "completed", "paused", "scheduled", ...(INCLUDE_STOPPED ? ["stopped"] : [])];
    const statusList = sql.join(campaignStatuses.map((s) => sql`${s}`), sql`, `);

    const rows = rowsOf<Row>(
        await db.execute(sql`
            WITH newest AS (
                SELECT DISTINCT ON (l.lead_id) l.id
                  FROM dialer_campaign_leads l
                 ORDER BY l.lead_id, l.created_at DESC NULLS LAST, l.id DESC
            )
            SELECT l.id, l.campaign_id, c.name AS campaign_name, c.status AS campaign_status,
                   l.status, l.call_outcome, l.attempt_count,
                   c.max_retries, c.schedule_mode, c.window_start, c.window_end, c.window_days
              FROM dialer_campaign_leads l
              JOIN newest n ON n.id = l.id
              JOIN dialer_campaigns c ON c.id = l.campaign_id
             WHERE l.next_attempt_at IS NULL
               AND l.status NOT IN ('pending', 'calling', 'skipped')
               AND c.status IN (${statusList})
               ${campaignArg ? sql`AND c.id = ${campaignArg}` : sql``}
               ${sinceArg ? sql`AND c.created_at >= ${sinceArg}::date` : sql``}
        `),
    );

    const now = new Date();
    const orgWindow = await defaultRetryWindow();
    type Plan = { row: Row; at: Date };
    const plans: Plan[] = [];
    const skipped = { not_retryable: 0, budget_spent: 0 };

    for (const r of rows) {
        if (!isAutoRetryable(r.status, r.call_outcome)) {
            skipped.not_retryable++;
            continue;
        }
        const dials = Math.max(Number(r.attempt_count ?? 0), 1);
        if (dials >= 1 + effectiveMaxRetries(r.max_retries)) {
            skipped.budget_spent++;
            continue;
        }
        const scheduled = r.schedule_mode && r.schedule_mode !== "now" && r.window_start && r.window_end;
        const window: RetryWindow = scheduled
            ? {
                  start: r.window_start!,
                  end: r.window_end!,
                  days: Array.isArray(r.window_days) ? (r.window_days as string[]) : null,
              }
            : orgWindow;
        const at = clampIntoWindow(new Date(now.getTime() + 60_000), withinDialerHours(window));
        plans.push({ row: r, at });
    }

    // Per-campaign summary.
    const byCampaign = new Map<string, { name: string | null; status: string; n: number; statuses: Record<string, number> }>();
    for (const { row } of plans) {
        const e = byCampaign.get(row.campaign_id) ?? {
            name: row.campaign_name,
            status: row.campaign_status,
            n: 0,
            statuses: {},
        };
        e.n++;
        e.statuses[row.status] = (e.statuses[row.status] ?? 0) + 1;
        byCampaign.set(row.campaign_id, e);
    }

    console.log(`${APPLY ? "APPLY" : "DRY RUN"} — campaign statuses: ${campaignStatuses.join(", ")}`);
    console.log(`scanned ${rows.length} newest-per-lead finished rows; to book ${plans.length}; ` +
        `skipped ${skipped.not_retryable} done (completed / wrong number), ${skipped.budget_spent} out of dials`);
    for (const [id, e] of [...byCampaign.entries()].sort((a, b) => b[1].n - a[1].n)) {
        const mix = Object.entries(e.statuses).map(([s, n]) => `${s} ${n}`).join(", ");
        console.log(`  ${id}  [${e.status}]  ${e.n} rows  (${mix})  ${e.name ?? ""}`);
    }
    if (!APPLY || plans.length === 0) return;

    let booked = 0;
    for (const { row, at } of plans) {
        const res = rowsOf<{ id: string }>(
            await db.execute(sql`
                UPDATE dialer_campaign_leads
                   SET next_attempt_at = ${at.toISOString()}::timestamptz
                 WHERE id = ${row.id}
                   AND status = ${row.status}
                   AND next_attempt_at IS NULL
                RETURNING id
            `),
        );
        booked += res.length;
    }

    // A finished campaign with retries booked is not finished: re-open it so
    // wakeDueRetries (60 s window tick) dials them. Other statuses resume as usual.
    const reopen = [...byCampaign.entries()].filter(([, e]) => e.status === "completed" || e.status === "stopped").map(([id]) => id);
    let reopened = 0;
    for (const id of reopen) {
        const res = rowsOf<{ id: string }>(
            await db.execute(sql`
                UPDATE dialer_campaigns SET status = 'running', completed_at = NULL
                 WHERE id = ${id} AND status IN ('completed', 'stopped')
                RETURNING id
            `),
        );
        reopened += res.length;
    }
    console.log(`booked ${booked} retries; re-opened ${reopened} campaign(s) to running`);
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error(err instanceof Error ? (err.cause ?? err.message) : err);
        process.exit(1);
    });
