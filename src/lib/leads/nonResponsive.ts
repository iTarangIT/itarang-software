/**
 * Non-responsive dealers (review R-16, metric M20, Requirement #6 decision):
 *
 *   at least 6 calls, on 6 DIFFERENT days, within the last 45 days,
 *   and not one of them connected.
 *
 * Such a number is almost certainly dead or refusing. Left in the active base
 * it inflates every idle count and every funnel denominator, and sits on a
 * rep's needs-attention list forever. It is shown as its OWN bucket instead,
 * and excluded from the active / stale counts.
 *
 * Evaluated LIVE rather than as a nightly flag column: a flag written by a job
 * is stale between runs and silently wrong the day the job stops, while this
 * reads the call log directly (lead_touchpoints_lead_perf_idx covers it). The
 * moment a call connects, the lead is simply no longer non-responsive.
 *
 * A "call" is any dial attempt — inside_sales_call (reps and NeoDove) and
 * ai_call. A dead number is dead whoever dialled it. Days are IST calendar days.
 *
 * isNonResponsive() is the pure twin used by the unit tests; the SQL below is
 * what every report runs. Keep the two in step.
 */
import { sql, type SQL } from "drizzle-orm";

export const NON_RESPONSIVE_MIN_CALL_DAYS = 6;
export const NON_RESPONSIVE_WINDOW_DAYS = 45;

/**
 * Boolean SQL: is the lead `leadId` (an SQL expression such as `dl.id`)
 * non-responsive as of now?
 */
export function nonResponsiveSql(leadId: SQL): SQL {
    return sql`(
        SELECT COUNT(DISTINCT (nr.performed_at AT TIME ZONE 'Asia/Kolkata')::date) >= ${NON_RESPONSIVE_MIN_CALL_DAYS}::int
               AND COUNT(*) FILTER (WHERE nr.call_status = 'connected') = 0
          FROM lead_touchpoints nr
         WHERE nr.dealer_lead_id = ${leadId}
           AND nr.touchpoint_type IN ('inside_sales_call', 'ai_call')
           AND nr.performed_at >= now() - make_interval(days => ${NON_RESPONSIVE_WINDOW_DAYS}::int)
    )`;
}

export type CallForRule = { performed_at: Date; call_status: string | null };

/** IST calendar day of a timestamp, as YYYY-MM-DD. */
function istDay(d: Date): string {
    return new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

/** Pure twin of nonResponsiveSql — for tests and any in-memory caller. */
export function isNonResponsive(calls: CallForRule[], now: Date = new Date()): boolean {
    const from = now.getTime() - NON_RESPONSIVE_WINDOW_DAYS * 86_400_000;
    const inWindow = calls.filter((c) => c.performed_at.getTime() >= from);
    if (inWindow.some((c) => c.call_status === "connected")) return false;
    const days = new Set(inWindow.map((c) => istDay(c.performed_at)));
    return days.size >= NON_RESPONSIVE_MIN_CALL_DAYS;
}
