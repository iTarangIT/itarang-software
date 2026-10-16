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

// ── Holiday change log (E-343, ID 85 item 7) ─────────────────────────────────

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] })?.rows ?? [])) as T[];

/** Is E-343's holiday_calendar_log on this database? */
export async function hasHolidayLog(): Promise<boolean> {
    try {
        const r = rowsOf<{ ok: boolean }>(await db.execute(sql`SELECT to_regclass('public.holiday_calendar_log') IS NOT NULL AS ok`));
        return Boolean(r[0]?.ok);
    } catch {
        return false;
    }
}

/** Record a holiday change. A no-op without E-343; never throws. */
export async function logHolidayChange(input: {
    date: string;
    action: "add" | "remove" | "rename";
    name: string | null;
    by: string | null;
    note?: string | null;
}): Promise<void> {
    try {
        if (!(await hasHolidayLog())) return;
        await db.execute(sql`
            INSERT INTO holiday_calendar_log (holiday_date, action, holiday_name, note, changed_by)
            VALUES (${input.date}::date, ${input.action}, ${input.name}, ${input.note ?? null}, ${input.by})`);
    } catch (e) {
        console.warn("[holidays] could not log the change:", e instanceof Error ? e.message : e);
    }
}

export type HolidayLogEntry = {
    id: number;
    holiday_date: string;
    action: "add" | "remove" | "rename";
    holiday_name: string | null;
    note: string | null;
    changed_by_name: string | null;
    changed_at: string;
};

/** The holiday log, newest first; [] without E-343. */
export async function holidayLog(limit = 200): Promise<HolidayLogEntry[]> {
    if (!(await hasHolidayLog())) return [];
    return rowsOf<HolidayLogEntry>(
        await db.execute(sql`
            SELECT l.id::int AS id, l.holiday_date::text AS holiday_date, l.action, l.holiday_name, l.note,
                   l.changed_at::text AS changed_at, u.name AS changed_by_name
              FROM holiday_calendar_log l
              LEFT JOIN users u ON u.id::text = l.changed_by
             ORDER BY l.changed_at DESC, l.id DESC
             LIMIT ${limit}`),
    );
}

/**
 * The holidays as they stood at any moment: a holiday counts for a clock only
 * if it was on the calendar when the clock stopped (buildHolidayBook). Without
 * E-343 every moment sees today's list, as before.
 */
export async function holidaysAsOf(): Promise<(at: Date) => ReadonlySet<string>> {
    const { buildHolidayBook } = await import("@/lib/calendar/holidayBook");
    try {
        const current = rowsOf<{ d: string; active: boolean }>(
            await db.execute(sql`SELECT holiday_date::text AS d, is_active IS NOT FALSE AS active FROM holiday_calendar WHERE holiday_date IS NOT NULL`),
        );
        const log = (await hasHolidayLog())
            ? rowsOf<{ d: string; action: "add" | "remove" | "rename"; at: string }>(
                  await db.execute(sql`SELECT holiday_date::text AS d, action, changed_at AS at FROM holiday_calendar_log ORDER BY changed_at, id`),
              )
            : [];
        return buildHolidayBook(
            current.map((r) => ({ date: r.d, active: Boolean(r.active) })),
            log.map((r) => ({ date: r.d, action: r.action, at: new Date(r.at) })),
        );
    } catch (e) {
        console.warn("[officeCalendar] holiday history unavailable — using today's list:", e instanceof Error ? e.message : e);
        const days = await loadHolidays();
        return () => days;
    }
}
