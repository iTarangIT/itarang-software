/**
 * Tracker ID 77.1 — "Awaiting field visit" (Transferred_to_ASM) has a limit:
 * the ASM's first visit is due within N working days (Mon–Sat, active
 * holidays off) of the transfer. N is the `asm_transfer_first_visit` time
 * limit (ID 85, src/lib/timeLimits — dated, edited on Admin › Settings › Time
 * limits; E-337 copied the old app_settings value across), default 3. Each
 * transfer is judged by the limit in force on the day it happened (dated
 * limits, 15 Oct): pass transferLimitSql() to transferVisitOverdueSql().
 *
 * Overdue = the lead is STILL Transferred_to_ASM, more than N working days have
 * passed since its latest move into Transferred_to_ASM (lead_status_history;
 * assigned_at for a lead with no history row), and no visit has been marked
 * visited since. Read by the admin alert panel and the needs-attention list —
 * the SQL lives here so the two cannot disagree.
 */
import { sql, type SQL } from "drizzle-orm";

import { workingDaysSinceSql } from "@/lib/calendar/holidays";
import { limitOnDay } from "@/lib/timeLimits/store";

/** When the lead (aliased `dl`) last entered Transferred_to_ASM — raw SQL text. */
export const TRANSFER_AT_EXPR = `COALESCE((
    SELECT MAX(h.changed_at) FROM dealer_lead_status_history h
     WHERE h.dealer_lead_id = dl.id AND h.to_status = 'Transferred_to_ASM'
), dl.assigned_at, dl.created_at)`;

/** Working days (Mon–Sat, holidays off, IST) since the transfer — an int scalar. */
export const TRANSFER_WORKING_DAYS_SQL: SQL = workingDaysSinceSql(sql.raw(TRANSFER_AT_EXPR));

/** The asm_transfer_first_visit limit in force on the IST day of the lead's (`dl`) transfer. */
export async function transferLimitSql(): Promise<SQL> {
    const onDay = await limitOnDay("asm_transfer_first_visit");
    return onDay(sql`((${sql.raw(TRANSFER_AT_EXPR)}) AT TIME ZONE 'Asia/Kolkata')::date`);
}

/**
 * Boolean predicate over `dl`: the transfer's first visit is overdue. `limit`
 * is a number of working days, or transferLimitSql() — the limit in force on
 * the transfer's day.
 */
export function transferVisitOverdueSql(limit: number | SQL): SQL {
    const l = typeof limit === "number" ? sql.raw(String(Math.max(0, Math.floor(limit)))) : sql`FLOOR(${limit})`;
    return sql`(${awaitingFieldVisitSql()} AND ${TRANSFER_WORKING_DAYS_SQL} > ${l})`;
}

/** Boolean predicate over `dl`: waiting for the ASM's first visit, past the limit or not. */
export function awaitingFieldVisitSql(): SQL {
    return sql`(
    dl.lead_status = 'Transferred_to_ASM'
    AND dl.is_active IS NOT FALSE
    AND NOT EXISTS (
        SELECT 1 FROM lead_visits v
         WHERE v.dealer_lead_id = dl.id
           AND v.visit_status = 'visited'
           AND (v.created_at >= ${sql.raw(TRANSFER_AT_EXPR)}
                OR v.actual_visit_date >= ((${sql.raw(TRANSFER_AT_EXPR)}) AT TIME ZONE 'Asia/Kolkata')::date)
    )
)`;
}
