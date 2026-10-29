// AI dialer review (23 Oct 2026, point 9) — the campaign outcome report: how
// every call of a campaign was categorised (callCategory.ts), next to the
// reach counts the campaign card already shows.
//
// Two levels, both shown:
//   calls  every dial the AI agent ANSWERED (retries included) — an
//          ai_call_outcomes row. A dial the carrier refused (busy, SIP 404,
//          timeout) never reaches the agent and has no row; `dials` counts
//          every dial from the campaign rows' attempt history.
//   leads  EVERY campaign lead, counted ONCE (29 Oct). Read from the campaign
//          rows — the same source as the status cards — so the tiles sum to
//          the Total leads card and "connected" equals the Completed card. A
//          lead is filed by its latest answered call when that call is the
//          row's current result; otherwise by the row's own status (busy →
//          unavailable, a dead number → wrong number). It used to count only
//          leads with an answered call, by an older call when the latest dial
//          was refused, and retries booked long ago on a finished campaign.
// Callback counts come from lead_callbacks (open / done / expired, by owner).
//
// Read-only. Returns { available: false } on a database without E-356 so the
// page can say "not recorded yet" instead of showing zeros that read as fact.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { hasCallOutcomeTables } from "@/lib/ai/storage/callOutcomeStore";
import { CALL_CATEGORIES, type CallCategory } from "./callCategory";

/**
 * One campaign lead's outcome category, from its row `l` (dialer_campaign_leads)
 * — THE rule, shared by the outcome tiles (campaignOutcomeReport) and the lead
 * list a tile filters (/api/ai-dialer/campaigns/[id]/leads), so a tile reading
 * 11 always lists 11. SQL, because the list filters on it.
 *
 *   * not finished (pending / calling / skipped) → NULL, not counted
 *   * the latest ANSWERED call, when it is what the row shows now (same status,
 *     or the dealer spoke) → its category
 *   * otherwise the row's own status, as callCategory.categorizeCall files a
 *     call with no analysis: failed → wrong_number for a dead number (SIP 404 /
 *     "invalid_number") else failed; hung_up → hung_up; completed →
 *     no_interest_signal; every other unreached status → unavailable.
 */
export function leadCategorySql(campaignLeadAlias = "l") {
    const l = sql.raw(campaignLeadAlias);
    return sql<string | null>`(
        CASE
          WHEN ${l}.status IN ('pending', 'calling', 'skipped') THEN NULL
          ELSE COALESCE(
            (SELECT x.category FROM ai_call_outcomes x
              WHERE x.campaign_id = ${l}.campaign_id
                AND (x.campaign_lead_id = ${l}.id OR (x.campaign_lead_id IS NULL AND x.lead_id = ${l}.lead_id))
                AND (x.campaign_status = ${l}.status OR ${l}.status = 'completed')
                AND x.created_at >= COALESCE((
                      SELECT max(y.created_at) FROM ai_call_outcomes y
                       WHERE y.campaign_id = ${l}.campaign_id
                         AND (y.campaign_lead_id = ${l}.id OR (y.campaign_lead_id IS NULL AND y.lead_id = ${l}.lead_id))),
                      x.created_at)
              ORDER BY x.created_at DESC LIMIT 1),
            CASE
              WHEN ${l}.status = 'failed'
                   AND ${l}.call_outcome ~* '(invalid_number|sip status: ?404|SIP 404)' THEN 'wrong_number'
              WHEN ${l}.status = 'failed' THEN 'failed'
              WHEN ${l}.status = 'hung_up' THEN 'hung_up'
              WHEN ${l}.status = 'completed' THEN 'no_interest_signal'
              ELSE 'unavailable'
            END)
        END
    )`;
}

export type CampaignOutcomeReport = {
    available: boolean;
    /** Every dial of the campaign, retries included (attempt history). */
    dials: number;
    /** Dials the AI agent answered — each has a category (retries included). */
    calls: number;
    /** …of which the dealer spoke. */
    connectedCalls: number;
    /** Every finished campaign lead, once (= the Total leads card once done). */
    leads: number;
    /** …where the dealer spoke (= the Completed card). */
    connectedLeads: number;
    /** Per category, counted once per lead (latest dial). */
    byCategory: Record<CallCategory, number>;
    /** Per category, every dial. */
    byCategoryCalls: Record<CallCategory, number>;
    /** Leads with an automatic retry still to come (0 once the campaign has finished). */
    retryBooked: number;
    callbacks: {
        aiOpen: number;
        salesOpen: number;
        done: number;
        expired: number;
        cancelled: number;
    };
};

function zeroCategories(): Record<CallCategory, number> {
    return Object.fromEntries(CALL_CATEGORIES.map((c) => [c, 0])) as Record<CallCategory, number>;
}

function rows<T>(r: unknown): T[] {
    return ((r as { rows?: T[] }).rows ?? (r as T[])) || [];
}

export function emptyOutcomeReport(available: boolean): CampaignOutcomeReport {
    return {
        available,
        dials: 0,
        calls: 0,
        connectedCalls: 0,
        leads: 0,
        connectedLeads: 0,
        byCategory: zeroCategories(),
        byCategoryCalls: zeroCategories(),
        retryBooked: 0,
        callbacks: { aiOpen: 0, salesOpen: 0, done: 0, expired: 0, cancelled: 0 },
    };
}

export async function campaignOutcomeReport(campaignId: string): Promise<CampaignOutcomeReport> {
    if (!(await hasCallOutcomeTables())) return emptyOutcomeReport(false);
    const report = emptyOutcomeReport(true);
    try {
        const perCall = rows<{ category: string; n: number; connected: number }>(await db.execute(sql`
            SELECT category, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE connected)::int AS connected
              FROM ai_call_outcomes
             WHERE campaign_id = ${campaignId}
             GROUP BY category
        `));
        for (const r of perCall) {
            report.calls += Number(r.n);
            report.connectedCalls += Number(r.connected);
            if (r.category in report.byCategoryCalls) report.byCategoryCalls[r.category as CallCategory] = Number(r.n);
        }

        // Leads — from the campaign rows, the same source as the status cards.
        const leadRows = rows<{ dials: number; category: string | null; connected: boolean; retry_pending: boolean }>(
            await db.execute(sql`
                SELECT COALESCE(jsonb_array_length(l.attempt_history), 0)::int AS dials,
                       ${leadCategorySql("l")} AS category,
                       (l.status = 'completed') AS connected,
                       (l.next_attempt_at IS NOT NULL AND c.status IN ('running', 'scheduled', 'paused')) AS retry_pending
                  FROM dialer_campaign_leads l
                  JOIN dialer_campaigns c ON c.id = l.campaign_id
                 WHERE l.campaign_id = ${campaignId}
            `),
        );
        for (const r of leadRows) {
            report.dials += Number(r.dials);
            if (!r.category) continue;
            report.leads += 1;
            if (r.connected) report.connectedLeads += 1;
            if (r.retry_pending) report.retryBooked += 1;
            if (r.category in report.byCategory) report.byCategory[r.category as CallCategory] += 1;
        }

        const cbs = rows<{ owner_type: string; status: string; n: number }>(await db.execute(sql`
            SELECT owner_type, status, COUNT(*)::int AS n
              FROM lead_callbacks
             WHERE campaign_id = ${campaignId}
             GROUP BY owner_type, status
        `));
        for (const r of cbs) {
            const n = Number(r.n);
            if (r.status === "open" || r.status === "dialing") {
                if (r.owner_type === "sales") report.callbacks.salesOpen += n;
                else report.callbacks.aiOpen += n;
            } else if (r.status === "done") report.callbacks.done += n;
            else if (r.status === "expired") report.callbacks.expired += n;
            else if (r.status === "cancelled") report.callbacks.cancelled += n;
        }
        return report;
    } catch (e) {
        console.warn("[campaignOutcomes] report failed:", e instanceof Error ? e.message : e);
        return emptyOutcomeReport(false);
    }
}
