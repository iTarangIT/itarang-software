/**
 * Office hours as a dated Admin setting (tracker ID 85 #8) — the SERVER half.
 * Server only. The pure rules are in src/lib/calendar/officeHours.ts.
 *
 * office_hours_settings (E-354) is append-only, like time_limit_settings
 * (src/lib/timeLimits/store.ts, the model for this file): each change is a row
 * with the IST day it takes effect, its opening / closing hour and working
 * weekdays, who set it and why. The hours in force on day D are the latest row
 * with effective_from <= D (ties: the later change); no row = Mon–Sat
 * 10:00–19:00. The table IS the change log Admin and the CEO read.
 *
 * Without E-354 (probed with to_regclass, cached) every read is the default
 * and a save answers 503, so code on a database in either state is safe.
 */
import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { db } from "@/lib/db";
import { istDay } from "@/lib/calendar/officeCalendar";
import {
    DEFAULT_OFFICE_HOURS,
    normaliseWeekdays,
    officeHoursOn,
    officeHoursProblem,
    officeHoursResolverFrom,
    rowToHours,
    type OfficeHours,
    type OfficeHoursResolver,
    type OfficeHoursRow,
} from "@/lib/calendar/officeHours";

export type OfficeHoursChange = {
    id: number;
    effective_from: string;
    start_hour: number;
    end_hour: number;
    working_weekdays: number[];
    /** The hours this change replaced (the default for the first change). */
    previous: OfficeHours;
    note: string;
    set_by_name: string | null;
    created_at: string;
};

export class OfficeHoursUnavailableError extends Error {}

const TTL_MS = 60 * 1000;
type Snapshot = { at: number; table: boolean; rows: OfficeHoursRow[] | null };
let cache: Snapshot | null = null;
let inflight: Promise<Snapshot> | null = null;

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] })?.rows ?? [])) as T[];

async function probe(): Promise<boolean> {
    try {
        const r = rowsOf<{ ok: boolean }>(await db.execute(sql`SELECT to_regclass('public.office_hours_settings') IS NOT NULL AS ok`));
        return Boolean(r[0]?.ok);
    } catch {
        return false;
    }
}

async function read(): Promise<Snapshot> {
    let table = false;
    let rows: OfficeHoursRow[] | null = null;
    try {
        table = await probe();
        if (table) {
            rows = rowsOf<OfficeHoursRow>(
                await db.execute(sql`
                    SELECT effective_from::text AS effective_from, start_hour, end_hour, working_weekdays
                      FROM office_hours_settings
                     ORDER BY effective_from, created_at, id`),
            );
        }
    } catch (e) {
        console.warn("[officeHours] read failed — using Mon–Sat 10:00–19:00:", e instanceof Error ? e.message : e);
    }
    return { at: Date.now(), table, rows };
}

/** Every change, oldest first, plus the table probe. Cached a minute; one read in flight at a time. */
async function snapshot(): Promise<Snapshot> {
    if (cache && Date.now() - cache.at < TTL_MS) return cache;
    if (!inflight) {
        inflight = read()
            .then((s) => (cache = s))
            .finally(() => {
                inflight = null;
            });
    }
    return inflight;
}

/** Is E-354 on this database? Cached with the rows. */
export async function hasOfficeHoursTable(): Promise<boolean> {
    return (await snapshot()).table;
}

/** Drop the cache (after a save, or in a script that changes the rows). */
export function forgetOfficeHours(): void {
    cache = null;
}

/**
 * Load (or refresh) the rows so the synchronous SQL fragments below see the
 * setting. loadHolidays() calls it, so any server code that loads the office
 * calendar has primed this too. Never throws.
 */
export async function primeOfficeHours(): Promise<void> {
    await snapshot().catch(() => undefined);
}

/** The office hours in force on an IST day (default: today). Never throws. */
export async function getOfficeHours(day: string = istDay(new Date())): Promise<OfficeHours> {
    return officeHoursOn(day, (await snapshot()).rows);
}

/**
 * A resolver for many days at once — for spans that may cross a dated change
 * (a clock started under the old hours and finished under the new). One read,
 * then pure lookups. Pass it wherever an office-calendar function takes
 * `hours`.
 */
export async function officeHoursResolver(): Promise<OfficeHoursResolver> {
    return officeHoursResolverFrom((await snapshot()).rows);
}

/** The next change dated after `today`, if any — shown beside the current hours. */
export async function scheduledOfficeHours(today: string = istDay(new Date())): Promise<(OfficeHours & { effective_from: string }) | null> {
    let next: (OfficeHours & { effective_from: string }) | null = null;
    for (const r of (await snapshot()).rows ?? []) {
        const h = rowToHours(r);
        if (h && r.effective_from > today) next = { ...h, effective_from: r.effective_from };
    }
    return next;
}

/** The change log, newest first, with the hours each change replaced. */
export async function officeHoursLog(limit = 200): Promise<OfficeHoursChange[]> {
    if (!(await hasOfficeHoursTable())) return [];
    const rows = rowsOf<OfficeHoursRow & { id: number; note: string; set_by_name: string | null; created_at: string }>(
        await db.execute(sql`
            SELECT o.id::int AS id, o.effective_from::text AS effective_from, o.start_hour, o.end_hour, o.working_weekdays,
                   o.note, o.created_at::text AS created_at, u.name AS set_by_name
              FROM office_hours_settings o
              LEFT JOIN users u ON u.id = o.set_by
             ORDER BY o.effective_from, o.created_at, o.id`),
    );
    // Oldest first here, so "previous" is simply the value before each row.
    const out: OfficeHoursChange[] = [];
    let previous: OfficeHours = DEFAULT_OFFICE_HOURS;
    for (const r of rows) {
        const h = rowToHours(r) ?? previous;
        out.push({
            id: Number(r.id),
            effective_from: r.effective_from,
            start_hour: h.startHour,
            end_hour: h.endHour,
            working_weekdays: [...h.weekdays],
            previous,
            note: r.note,
            set_by_name: r.set_by_name,
            created_at: r.created_at,
        });
        previous = h;
    }
    return out.reverse().slice(0, limit);
}

/**
 * Record a change. `effectiveFrom` must be today or later (IST) — the hours
 * are never changed retroactively, so a past report keeps the hours it was
 * judged by. A reason is required. Throws a plain Error with a reason the
 * screen can show; OfficeHoursUnavailableError without E-354.
 */
export async function setOfficeHours(input: {
    startHour: number;
    endHour: number;
    weekdays: readonly number[];
    effectiveFrom: string;
    note: string;
    actorId: string;
}): Promise<void> {
    if (input.weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new Error("Working days are 0 (Sunday) to 6 (Saturday).");
    const weekdays = normaliseWeekdays(input.weekdays);
    const problem = officeHoursProblem({ startHour: input.startHour, endHour: input.endHour, weekdays });
    if (problem) throw new Error(problem);
    const today = istDay(new Date());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveFrom) || input.effectiveFrom < today) {
        throw new Error("A change takes effect today or later, never in the past.");
    }
    const note = input.note.trim();
    if (note.length < 3) throw new Error("Give a reason for the change (shown in the log).");
    if (!(await hasOfficeHoursTable())) throw new OfficeHoursUnavailableError("Office hours are not set up on this server (E-354).");

    const days = sql.raw(`ARRAY[${weekdays.join(",")}]::int[]`);
    await db.execute(sql`
        INSERT INTO office_hours_settings (effective_from, start_hour, end_hour, working_weekdays, note, set_by)
        VALUES (${input.effectiveFrom}::date, ${input.startHour}::int, ${input.endHour}::int, ${days}, ${note}, ${input.actorId}::uuid)
    `);
    cache = null;
}

// ── SQL ──────────────────────────────────────────────────────────────────────

const dowList = (h: OfficeHours): SQL => sql.raw(normaliseWeekdays(h.weekdays).join(", ") || "-1");

function weekdayPredicate(day: SQL, rows: readonly OfficeHoursRow[] | null): SQL {
    const dow = sql`EXTRACT(DOW FROM (${day}))::int`;
    const valid = (rows ?? []).map((r) => ({ from: r.effective_from, h: rowToHours(r) })).filter((r) => r.h != null);
    if (valid.length === 0) return sql`${dow} IN (${dowList(DEFAULT_OFFICE_HOURS)})`;
    // Newest first: the first WHEN whose date has been reached is the row in force.
    const whens = [...valid].reverse().map((r) => sql`WHEN (${day})::date >= ${r.from}::date THEN ${dow} IN (${dowList(r.h as OfficeHours)})`);
    return sql`(CASE ${sql.join(whens, sql` `)} ELSE ${dow} IN (${dowList(DEFAULT_OFFICE_HOURS)}) END)`;
}

/**
 * SQL boolean: is the date expression `day` a working WEEKDAY under the
 * office hours in force that day? (Holidays are the caller's — see
 * workingDaysBetweenSql in holidays.ts.)
 *
 * Synchronous on purpose — the working-day SQL helpers are used in module-level
 * constants. The fragment is LAZY: it is rendered when the query is built, from
 * the cached rows (literal values, no table reference, so a database without
 * E-354 is never asked for it). Rows not loaded yet — the first query after a
 * restart that did not go through loadHolidays()/primeOfficeHours() — render
 * the Mon–Sat default and start a load for the next query.
 */
export function workingWeekdaySql(day: SQL): SQLWrapper {
    return {
        getSQL(): SQL {
            if (!cache || Date.now() - cache.at >= TTL_MS) void primeOfficeHours();
            return weekdayPredicate(day, cache?.rows ?? null);
        },
    };
}

/** Test hook: render the predicate for given rows without touching the cache. */
export const __weekdayPredicateForTest = weekdayPredicate;
