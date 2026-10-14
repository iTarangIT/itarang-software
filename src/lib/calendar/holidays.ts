/**
 * Server side of the office calendar (ID 85, Part 1): the active holidays, and
 * the SQL twin of officeCalendar.workingDaysSince().
 */
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";

const TTL_MS = 5 * 60 * 1000;
let cache: { at: number; days: ReadonlySet<string> } | null = null;

/** Active holiday dates (IST YYYY-MM-DD). Cached 5 minutes; a failed read is "no holidays". */
export async function loadHolidays(): Promise<ReadonlySet<string>> {
    if (cache && Date.now() - cache.at < TTL_MS) return cache.days;
    try {
        const rows = (await db.execute(sql`
            SELECT holiday_date::text AS d FROM holiday_calendar
             WHERE is_active IS NOT FALSE AND holiday_date IS NOT NULL
        `)) as unknown as Array<{ d: string }>;
        cache = { at: Date.now(), days: new Set(rows.map((r) => r.d)) };
    } catch (e) {
        console.warn("[officeCalendar] holidays unavailable — counting Sundays only:", e instanceof Error ? e.message : e);
        cache = { at: Date.now(), days: new Set() };
    }
    return cache.days;
}

/** Drop the cache after the holiday list changes. */
export function forgetHolidays(): void {
    cache = null;
}

/**
 * Working days after the IST day of `ts` up to and including today (IST):
 * Mon–Sat, active holidays skipped. An int scalar — the SQL twin of
 * workingDaysSince(). `ts` is a timestamptz expression.
 */
export function workingDaysSinceSql(ts: SQL): SQL {
    return workingDaysBetweenSql(ts, sql`NOW()`);
}

/**
 * Working days after the IST day of `from` up to and including the IST day of
 * `to` (Mon–Sat, active holidays skipped); 0 when `to` is not after `from`.
 * Both are timestamptz expressions.
 */
export function workingDaysBetweenSql(from: SQL, to: SQL): SQL {
    return sql`(
        SELECT COUNT(*) FROM generate_series(
            ((${from}) AT TIME ZONE 'Asia/Kolkata')::date + 1,
            ((${to}) AT TIME ZONE 'Asia/Kolkata')::date, INTERVAL '1 day'
        ) gs
         WHERE EXTRACT(DOW FROM gs) <> 0
           AND gs::date NOT IN (SELECT hc.holiday_date FROM holiday_calendar hc
                                 WHERE hc.is_active IS NOT FALSE AND hc.holiday_date IS NOT NULL)
    )::int`;
}
