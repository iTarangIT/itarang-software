// AI dialer review (23 Oct 2026, point 9) — the campaign outcome report: how
// every call of a campaign was categorised (callCategory.ts), next to the
// reach counts the campaign card already shows.
//
// Two levels, both shown:
//   calls  every finished dial (retries included) — "how did the dials go?"
//   leads  each campaign lead counted ONCE, by its LATEST categorised dial —
//          "what do we do with each lead now?" This is what the tiles show,
//          so the categories sum to the leads categorised.
// Callback counts come from lead_callbacks (open / done / expired, by owner).
//
// Read-only. Returns { available: false } on a database without E-356 so the
// page can say "not recorded yet" instead of showing zeros that read as fact.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { hasCallOutcomeTables } from "@/lib/ai/storage/callOutcomeStore";
import { CALL_CATEGORIES, type CallCategory } from "./callCategory";

export type CampaignOutcomeReport = {
    available: boolean;
    /** Finished dials with a category (retries included). */
    calls: number;
    /** …of which the dealer spoke. */
    connectedCalls: number;
    /** Campaign leads with at least one categorised dial. */
    leads: number;
    /** …whose latest dial connected. */
    connectedLeads: number;
    /** Per category, counted once per lead (latest dial). */
    byCategory: Record<CallCategory, number>;
    /** Per category, every dial. */
    byCategoryCalls: Record<CallCategory, number>;
    /** Leads whose latest dial booked an automatic retry. */
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

        const perLead = rows<{ category: string; n: number; connected: number; retry: number }>(await db.execute(sql`
            SELECT category, COUNT(*)::int AS n,
                   COUNT(*) FILTER (WHERE connected)::int AS connected,
                   COUNT(*) FILTER (WHERE will_retry)::int AS retry
              FROM (
                SELECT DISTINCT ON (COALESCE(campaign_lead_id, lead_id, call_id))
                       category, connected, will_retry
                  FROM ai_call_outcomes
                 WHERE campaign_id = ${campaignId}
                 ORDER BY COALESCE(campaign_lead_id, lead_id, call_id), created_at DESC
              ) latest
             GROUP BY category
        `));
        for (const r of perLead) {
            report.leads += Number(r.n);
            report.connectedLeads += Number(r.connected);
            report.retryBooked += Number(r.retry);
            if (r.category in report.byCategory) report.byCategory[r.category as CallCategory] = Number(r.n);
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
