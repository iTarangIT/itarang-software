/**
 * The office calendar (tracker ID 85, Part 1) — one rule for every limit and
 * clock: Monday–Saturday are working days, Sunday and every active holiday in
 * Admin › Time limits › Office calendar (holiday_calendar, entered each
 * December) are not; working hours are 10:00–19:00 IST.
 *
 * CLIENT-SAFE and pure. The holiday set comes from loadHolidays()
 * (src/lib/calendar/holidays.ts) on the server; SQL that counts working days
 * uses workingDaysSinceSql() from the same file so the two cannot disagree.
 */

export { WORK_DAY_END_HOUR, WORK_DAY_START_HOUR, addWorkingMinutes, workingHoursBetween, workingMinutesBetween } from "@/lib/leads/workingHours";

const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DAYS = 800;

/** The IST calendar day of an instant, YYYY-MM-DD. */
export function istDay(at: Date): string {
    return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** True for Mon–Sat that is not an active holiday. `day` is an IST YYYY-MM-DD. */
export function isWorkingDay(day: string, holidays: ReadonlySet<string>): boolean {
    return new Date(`${day}T00:00:00Z`).getUTCDay() !== 0 && !holidays.has(day);
}

/**
 * Whole working days after the IST day of `start`, up to and including the IST
 * day of `now` — "N working days have passed since". Same count as
 * workingDaysSinceSql().
 */
export function workingDaysSince(start: Date, now: Date, holidays: ReadonlySet<string>): number {
    const from = Date.parse(`${istDay(start)}T00:00:00Z`);
    const to = Date.parse(`${istDay(now)}T00:00:00Z`);
    let n = 0;
    for (let d = from + DAY_MS, i = 0; d <= to && i < MAX_DAYS; d += DAY_MS, i++) {
        if (isWorkingDay(new Date(d).toISOString().slice(0, 10), holidays)) n++;
    }
    return n;
}

/**
 * When a limit of `days` working days that started at `start` falls due: the
 * end (23:59:59.999 IST) of the `days`-th working day after start's IST day.
 * A limit of N working days is passed from the start of working day N + 1.
 */
export function workingDaysDueAt(start: Date, days: number, holidays: ReadonlySet<string>): Date | null {
    let d = Date.parse(`${istDay(start)}T00:00:00Z`);
    let left = Math.max(1, Math.round(days));
    for (let i = 0; i < MAX_DAYS; i++) {
        d += DAY_MS;
        if (isWorkingDay(new Date(d).toISOString().slice(0, 10), holidays) && --left === 0) {
            return new Date(d + DAY_MS - 1 - IST_OFFSET_MS);
        }
    }
    return null;
}

/** When a limit of `days` calendar days falls due: exactly that long after start. */
export function calendarDaysDueAt(start: Date, days: number): Date {
    return new Date(start.getTime() + days * DAY_MS);
}
