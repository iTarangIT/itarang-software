/**
 * Office hours as a dated Admin setting (tracker ID 85 #8) — the PURE half.
 *
 * Which weekdays the office works and its opening / closing hour (IST) used to
 * be constants (Mon–Sat, 10:00–19:00). They are now rows in
 * office_hours_settings (E-354), append-only like time_limit_settings: the
 * hours in force on IST day D are the latest row with effective_from <= D;
 * no row (or no table) = DEFAULT_OFFICE_HOURS, the old constants.
 *
 * CLIENT-SAFE: no I/O. The server reads the rows through
 * src/lib/calendar/officeHoursStore.ts (getOfficeHours / officeHoursResolver)
 * and hands an OfficeHours, or a per-day resolver, to the office-calendar
 * functions (officeCalendar.ts, leads/workingHours.ts). Every one of those
 * takes it as an OPTIONAL last argument that defaults to these constants, so
 * pure callers and tests that pass nothing keep the Mon–Sat 10–19 rule.
 */

/** Opening hour, closing hour (IST, whole hours, start < end) and working weekdays (0 = Sunday … 6 = Saturday). */
export type OfficeHours = {
    startHour: number;
    endHour: number;
    weekdays: readonly number[];
};

/** The hours for one IST day (YYYY-MM-DD) — for spans that cross a dated change. */
export type OfficeHoursResolver = (day: string) => OfficeHours;

/** What the office-calendar functions accept: fixed hours, or a per-day resolver. */
export type OfficeHoursArg = OfficeHours | OfficeHoursResolver;

/** Monday–Saturday, 10:00–19:00 IST — the rule before E-354, and the fallback. */
export const DEFAULT_OFFICE_HOURS: OfficeHours = Object.freeze({
    startHour: 10,
    endHour: 19,
    weekdays: Object.freeze([1, 2, 3, 4, 5, 6]),
});

/** A stored change row, as the store reads it (oldest first). */
export type OfficeHoursRow = {
    effective_from: string;
    start_hour: number | string;
    end_hour: number | string;
    working_weekdays: readonly (number | string)[] | string | null;
};

export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
export const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** The hours for `day` from either form of OfficeHoursArg (default when omitted). */
export function hoursOn(hours: OfficeHoursArg | undefined, day: string): OfficeHours {
    if (!hours) return DEFAULT_OFFICE_HOURS;
    return typeof hours === "function" ? hours(day) : hours;
}

/** Postgres int[] comes back as an array, or as "{1,2,3}" text from a raw read. */
function weekdaysOf(v: OfficeHoursRow["working_weekdays"]): number[] {
    const list = Array.isArray(v) ? v : typeof v === "string" ? v.replace(/[{}\s]/g, "").split(",").filter(Boolean) : [];
    return normaliseWeekdays(list.map(Number));
}

/** Distinct, sorted, 0–6 only. */
export function normaliseWeekdays(days: readonly number[]): number[] {
    return [...new Set(days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b);
}

/** A row as OfficeHours, or null when it is unusable (then the earlier value stays). */
export function rowToHours(r: OfficeHoursRow): OfficeHours | null {
    const startHour = Number(r.start_hour);
    const endHour = Number(r.end_hour);
    const weekdays = weekdaysOf(r.working_weekdays);
    if (officeHoursProblem({ startHour, endHour, weekdays })) return null;
    return { startHour, endHour, weekdays };
}

/** Pure: the hours in force on `day` (IST YYYY-MM-DD) given the change rows, oldest first. */
export function officeHoursOn(day: string, rows: readonly OfficeHoursRow[] | null | undefined): OfficeHours {
    let out = DEFAULT_OFFICE_HOURS;
    for (const r of rows ?? []) {
        // Oldest first, so the last row dated on or before `day` wins.
        if (r.effective_from <= day) out = rowToHours(r) ?? out;
    }
    return out;
}

/** A memoised per-day resolver over the change rows. */
export function officeHoursResolverFrom(rows: readonly OfficeHoursRow[] | null | undefined): OfficeHoursResolver {
    if (!rows || rows.length === 0) return () => DEFAULT_OFFICE_HOURS;
    const memo = new Map<string, OfficeHours>();
    return (day) => {
        let v = memo.get(day);
        if (!v) memo.set(day, (v = officeHoursOn(day, rows)));
        return v;
    };
}

/** Why a value cannot be saved, or null when it is fine. */
export function officeHoursProblem(h: OfficeHours): string | null {
    if (!Number.isInteger(h.startHour) || !Number.isInteger(h.endHour)) return "Opening and closing must be whole hours.";
    if (h.startHour < 0 || h.endHour > 24) return "Hours run from 0 to 24.";
    if (h.startHour >= h.endHour) return "Closing must be after opening.";
    if (normaliseWeekdays(h.weekdays).length === 0) return "Pick at least one working day.";
    return null;
}

/** True when `dow` (0 = Sunday) is a working weekday under `h`. */
export function isWorkingWeekday(dow: number, h: OfficeHours = DEFAULT_OFFICE_HOURS): boolean {
    return h.weekdays.includes(dow);
}

const pad = (n: number) => `${String(n).padStart(2, "0")}:00`;

/** "Monday to Saturday" / "Monday to Friday and Sunday" — for screen copy. */
export function describeWeekdays(days: readonly number[]): string {
    const d = normaliseWeekdays(days);
    if (d.length === 7) return "every day";
    // Runs of consecutive days, Monday-first (Sunday last) as people read a week.
    const order = [1, 2, 3, 4, 5, 6, 0].filter((x) => d.includes(x));
    const runs: number[][] = [];
    for (const x of order) {
        const last = runs[runs.length - 1];
        const prev = last?.[last.length - 1];
        if (last && prev != null && (prev + 1) % 7 === x && !(prev === 0)) last.push(x);
        else runs.push([x]);
    }
    const parts = runs.map((r) =>
        r.length >= 3 ? `${WEEKDAY_NAMES[r[0]]} to ${WEEKDAY_NAMES[r[r.length - 1]]}` : r.map((x) => WEEKDAY_NAMES[x]).join(", "),
    );
    return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** "Monday to Saturday, 10:00 to 19:00" */
export function describeOfficeHours(h: OfficeHours = DEFAULT_OFFICE_HOURS): string {
    return `${describeWeekdays(h.weekdays)}, ${pad(h.startHour)} to ${pad(h.endHour)}`;
}

/** "Mon–Sat 10:00–19:00" — the short form used in hints and column meanings. */
export function shortOfficeHours(h: OfficeHours = DEFAULT_OFFICE_HOURS): string {
    const d = normaliseWeekdays(h.weekdays);
    const order = [1, 2, 3, 4, 5, 6, 0].filter((x) => d.includes(x));
    const contiguous = order.every((x, i) => i === 0 || (order[i - 1] + 1) % 7 === x);
    const days =
        d.length === 7
            ? "Every day"
            : contiguous && order.length >= 2
              ? `${WEEKDAY_SHORT[order[0]]}–${WEEKDAY_SHORT[order[order.length - 1]]}`
              : order.map((x) => WEEKDAY_SHORT[x]).join(", ");
    return `${days} ${pad(h.startHour)}–${pad(h.endHour)}`;
}
