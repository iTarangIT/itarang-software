/**
 * Sales Head "Team scorecard" — the Inside sales (ISR) tab's per-person
 * figures that the sales dashboard does not carry. Window [from, to], IST days.
 *
 *   calls / engaged   human calls (humanCall: a NeoDove re-disposition is one
 *                     call) and how many connected (engagedCall — the CRM's
 *                     "engaged" is a connected call, metricDefinitions.ts)
 *   hot_to_field      transfers to an ASM of a lead that was Hot AT THE MOMENT
 *                     of transfer (wasHotAt) — counted per transfer, exactly as
 *                     the hot_to_ground target's actual (targets/service.ts)
 *   hot_visited       of those transfers, how many the ASM went on to visit
 *                     (a lead_visits row marked visited after the transfer —
 *                     the same "visited" test as transferVisitLimit.ts)
 *   quotes_delivered  leads whose quote the person delivered to the dealer
 *                     (quote_dispatched touchpoints; a resend is not a second)
 *   won               leads the person moved to Won (status history)
 *
 * Every count is credited to the person who did it (performed_by /
 * changed_by), not the lead's current owner. `state` narrows by the lead.
 */
import { sql, type SQL } from "drizzle-orm";

import { db } from "@/lib/db";
import { engagedCall, humanCall, wasHotAt } from "@/lib/reports/metricDefinitions";

export type IsrScore = {
    calls: number;
    engaged: number;
    hot_to_field: number;
    hot_visited: number;
    quotes_delivered: number;
    won: number;
};

const IST = "Asia/Kolkata";
const inRange = (col: SQL, from: string, to: string) =>
    sql`(${col} AT TIME ZONE ${IST})::date BETWEEN ${from}::date AND ${to}::date`;

export async function buildIsrScorecard(f: { from: string; to: string; state?: string | null }): Promise<Record<string, IsrScore>> {
    const st = f.state ? sql` AND lower(trim(dl.state)) = lower(trim(${f.state}))` : sql``;
    const rows = (await db.execute(sql`
        WITH calls AS (
            SELECT t.performed_by AS u,
                   COUNT(*) FILTER (WHERE ${humanCall()})   AS calls,
                   COUNT(*) FILTER (WHERE ${engagedCall()}) AS engaged
              FROM lead_touchpoints t
              JOIN dealer_leads dl ON dl.id = t.dealer_lead_id
             WHERE t.touchpoint_type = 'inside_sales_call' AND t.performed_by IS NOT NULL
               AND ${inRange(sql`t.performed_at`, f.from, f.to)} ${st}
             GROUP BY 1
        ),
        hot AS (
            SELECT t.performed_by AS u, t.dealer_lead_id, t.performed_at AS at
              FROM lead_touchpoints t
              JOIN dealer_leads dl ON dl.id = t.dealer_lead_id
             WHERE t.touchpoint_type = 'asm_transfer' AND t.performed_by IS NOT NULL
               AND ${wasHotAt(sql`t.dealer_lead_id`, sql`t.performed_at`, sql`dl.interest_level`)}
               AND ${inRange(sql`t.performed_at`, f.from, f.to)} ${st}
        ),
        hotv AS (
            SELECT h.u, COUNT(*) AS n,
                   COUNT(*) FILTER (WHERE EXISTS (
                       SELECT 1 FROM lead_visits v
                        WHERE v.dealer_lead_id = h.dealer_lead_id AND v.visit_status = 'visited'
                          AND (v.created_at >= h.at OR v.actual_visit_date >= (h.at AT TIME ZONE ${IST})::date)
                   )) AS visited
              FROM hot h GROUP BY 1
        ),
        quotes AS (
            SELECT t.performed_by AS u, COUNT(DISTINCT t.dealer_lead_id) AS n
              FROM lead_touchpoints t
              JOIN dealer_leads dl ON dl.id = t.dealer_lead_id
             WHERE t.touchpoint_type = 'quote_dispatched' AND t.performed_by IS NOT NULL
               AND ${inRange(sql`t.performed_at`, f.from, f.to)} ${st}
             GROUP BY 1
        ),
        won AS (
            SELECT h.changed_by AS u, COUNT(DISTINCT h.dealer_lead_id) AS n
              FROM dealer_lead_status_history h
              JOIN dealer_leads dl ON dl.id = h.dealer_lead_id
             WHERE h.to_status = 'Won'
               AND ${inRange(sql`h.changed_at`, f.from, f.to)} ${st}
             GROUP BY 1
        ),
        people AS (
            SELECT u FROM calls UNION SELECT u FROM hotv UNION SELECT u FROM quotes UNION SELECT u FROM won
        )
        SELECT p.u,
               COALESCE(c.calls, 0)::int AS calls, COALESCE(c.engaged, 0)::int AS engaged,
               COALESCE(hv.n, 0)::int AS hot_to_field, COALESCE(hv.visited, 0)::int AS hot_visited,
               COALESCE(q.n, 0)::int AS quotes_delivered, COALESCE(w.n, 0)::int AS won
          FROM people p
          LEFT JOIN calls  c  ON c.u  = p.u
          LEFT JOIN hotv   hv ON hv.u = p.u
          LEFT JOIN quotes q  ON q.u  = p.u
          LEFT JOIN won    w  ON w.u  = p.u
    `)) as unknown as Array<Record<string, unknown>>;

    const out: Record<string, IsrScore> = {};
    for (const r of rows) {
        out[String(r.u)] = {
            calls: Number(r.calls),
            engaged: Number(r.engaged),
            hot_to_field: Number(r.hot_to_field),
            hot_visited: Number(r.hot_visited),
            quotes_delivered: Number(r.quotes_delivered),
            won: Number(r.won),
        };
    }
    return out;
}
