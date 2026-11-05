// Task 11 (D8) — the ISR metric: promised callbacks made within 30 minutes.
//
// The same rule as the missed-callbacks digest (digests/kinds/missed-callbacks.ts),
// the other way round: a sales callback handed to a person, due in the period
// and at least 30 minutes past, is ON TIME when that lead has an inside-sales
// call or a visit between 15 minutes before and 30 minutes after it was due.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

import { ON_TIME_AFTER_MIN, ON_TIME_BEFORE_MIN, onTimePct } from "./callbackBrief";

export { ON_TIME_AFTER_MIN, ON_TIME_BEFORE_MIN, onTimePct } from "./callbackBrief";

export type OwnerOnTime = {
    userId: string;
    name: string | null;
    due: number;
    onTime: number;
    /** 0–100, one decimal; null when nothing fell due. */
    pct: number | null;
};

function rowsOf<T>(r: unknown): T[] {
    return Array.isArray(r) ? (r as T[]) : ((r as { rows?: T[] }).rows ?? []);
}

/**
 * Per callback owner, callbacks due between two IST days (inclusive). Empty
 * without lead_callbacks (E-356).
 */
export async function callbackOnTimeByOwner(input: { fromIstDay: string; toIstDay: string }): Promise<OwnerOnTime[]> {
    try {
        const ok = rowsOf<{ ok: boolean }>(
            await db.execute(sql`SELECT to_regclass('public.lead_callbacks') IS NOT NULL AS ok`),
        )[0]?.ok;
        if (!ok) return [];
        const r = rowsOf<{ user_id: string; name: string | null; due: number; on_time: number }>(
            await db.execute(sql`
                SELECT lc.assigned_user_id::text AS user_id, u.name,
                       count(*)::int AS due,
                       count(*) FILTER (WHERE EXISTS (
                           SELECT 1 FROM lead_touchpoints t
                            WHERE t.dealer_lead_id = lc.lead_id
                              AND t.touchpoint_type IN ('inside_sales_call', 'visit')
                              AND t.performed_at BETWEEN lc.due_at - make_interval(mins => ${ON_TIME_BEFORE_MIN})
                                                     AND lc.due_at + make_interval(mins => ${ON_TIME_AFTER_MIN})
                       ))::int AS on_time
                  FROM lead_callbacks lc
                  LEFT JOIN users u ON u.id::text = lc.assigned_user_id::text
                 WHERE lc.owner_type = 'sales'
                   AND lc.assigned_user_id IS NOT NULL
                   AND (lc.due_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ${input.fromIstDay}::date AND ${input.toIstDay}::date
                   AND lc.due_at < now() - make_interval(mins => ${ON_TIME_AFTER_MIN})
                 GROUP BY lc.assigned_user_id, u.name
                 ORDER BY count(*) DESC
            `),
        );
        return r.map((x) => ({
            userId: x.user_id,
            name: x.name,
            due: Number(x.due),
            onTime: Number(x.on_time),
            pct: onTimePct(Number(x.on_time), Number(x.due)),
        }));
    } catch (err) {
        console.error("[callbackMetrics] on-time query failed:", err instanceof Error ? err.message : err);
        return [];
    }
}
