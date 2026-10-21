/**
 * The office calendar (tracker ID 85, Part 1) — one rule for every limit and
 * clock: the working weekdays and office hours in force (Admin › Time limits ›
 * Office hours, E-354; default Monday–Saturday, 10:00–19:00 IST) are working
 * time; every active holiday in Admin › Time limits › Office calendar
 * (holiday_calendar, entered each December) is not.
 *
 * THE one working-day calculation (18 Oct sheet, row 40): screens, emails and
 * exports count working days / hours with these functions (or the SQL twins in
 * src/lib/calendar/holidays.ts), never their own loop.
 *
 * CLIENT-SAFE and pure. The holiday set comes from loadHolidays() and the
 * hours from getOfficeHours() / officeHoursResolver()
 * (src/lib/calendar/officeHoursStore.ts) on the server — loadOfficeCalendar()
 * in holidays.ts returns both. Every function takes the hours as an OPTIONAL
 * last argument (fixed hours or a per-day resolver); omitted = the Mon–Sat
 * 10–19 default, so pure callers and tests need nothing new.
 */

import { hoursOn, type OfficeHoursArg } from "@/lib/calendar/officeHours";

export {
    WORK_DAY_END_HOUR,
    WORK_DAY_START_HOUR,
    addWorkingMinutes,
    workingDaysElapsed,
    workingHoursBetween,
    workingMinutesBetween,
} from "@/lib/leads/workingHours";
export {
    DEFAULT_OFFICE_HOURS,
    describeOfficeHours,
    shortOfficeHours,
    type OfficeHours,
    type OfficeHoursArg,
    type OfficeHoursResolver,
} from "@/lib/calendar/officeHours";

const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DAYS = 800;

/** The IST calendar day of an instant, YYYY-MM-DD. */
export function istDay(at: Date): string {
    return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** True for a working weekday (default Mon–Sat) that is not an active holiday. `day` is an IST YYYY-MM-DD. */
export function isWorkingDay(day: string, holidays: ReadonlySet<string>, hours?: OfficeHoursArg): boolean {
    return hoursOn(hours, day).weekdays.includes(new Date(`${day}T00:00:00Z`).getUTCDay()) && !holidays.has(day);
}

/**
 * Whole working days after the IST day of `start`, up to and including the IST
 * day of `now` — "N working days have passed since". Same count as
 * workingDaysSinceSql().
 */
export function workingDaysSince(start: Date, now: Date, holidays: ReadonlySet<string>, hours?: OfficeHoursArg): number {
    const from = Date.parse(`${istDay(start)}T00:00:00Z`);
    const to = Date.parse(`${istDay(now)}T00:00:00Z`);
    let n = 0;
    for (let d = from + DAY_MS, i = 0; d <= to && i < MAX_DAYS; d += DAY_MS, i++) {
        if (isWorkingDay(new Date(d).toISOString().slice(0, 10), holidays, hours)) n++;
    }
    return n;
}

/**
 * Working days in the IST date range [from, to], both ends included
 * (YYYY-MM-DD) — "N working days this month". 0 when `to` is before `from`.
 * The targets register's pro-rating (targets/rules.workingDaysBetween).
 */
export function workingDaysInRange(from: string, to: string, holidays: ReadonlySet<string>, hours?: OfficeHoursArg): number {
    if (to < from) return 0;
    const end = Date.parse(`${to}T00:00:00Z`);
    let n = 0;
    for (let d = Date.parse(`${from}T00:00:00Z`), i = 0; d <= end && i < MAX_DAYS * 10; d += DAY_MS, i++) {
        if (isWorkingDay(new Date(d).toISOString().slice(0, 10), holidays, hours)) n++;
    }
    return n;
}

/**
 * When a limit of `days` working days that started at `start` falls due: the
 * end (23:59:59.999 IST) of the `days`-th working day after start's IST day.
 * A limit of N working days is passed from the start of working day N + 1.
 */
export function workingDaysDueAt(start: Date, days: number, holidays: ReadonlySet<string>, hours?: OfficeHoursArg): Date | null {
    let d = Date.parse(`${istDay(start)}T00:00:00Z`);
    let left = Math.max(1, Math.round(days));
    for (let i = 0; i < MAX_DAYS; i++) {
        d += DAY_MS;
        if (isWorkingDay(new Date(d).toISOString().slice(0, 10), holidays, hours) && --left === 0) {
            return new Date(d + DAY_MS - 1 - IST_OFFSET_MS);
        }
    }
    return null;
}

/** When a limit of `days` calendar days falls due: exactly that long after start. */
export function calendarDaysDueAt(start: Date, days: number): Date {
    return new Date(start.getTime() + days * DAY_MS);
}
