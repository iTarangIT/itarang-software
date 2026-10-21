/**
 * Working time between two instants, for limits counted in working HOURS
 * (ID 86 clocks; the Sales Head "Hot leads not called in time" card).
 *
 * Working hours: the office hours in force (ID 85 #8, Admin › Time limits;
 * src/lib/calendar/officeHours.ts) — Monday–Saturday, 10:00–19:00 IST unless
 * Admin changed them. Pass the active holidays (IST YYYY-MM-DD,
 * loadHolidays()) to skip them; without the set only non-working weekdays are
 * off. Pass the hours (getOfficeHours() / officeHoursResolver() on the server)
 * as the last argument; omitted = the Mon–Sat 10–19 default. IST has no DST,
 * so a fixed +05:30 offset is exact. Pure: no I/O, unit-tested.
 */

import { DEFAULT_OFFICE_HOURS, hoursOn, type OfficeHours, type OfficeHoursArg } from "@/lib/calendar/officeHours";

/** The DEFAULT opening / closing hour — the live ones come from the office-hours setting. */
export const WORK_DAY_START_HOUR = DEFAULT_OFFICE_HOURS.startHour;
export const WORK_DAY_END_HOUR = DEFAULT_OFFICE_HOURS.endHour;

const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
/** Past this many calendar days the answer is "far over any limit" anyway. */
const MAX_DAYS = 400;

const NO_HOLIDAYS: ReadonlySet<string> = new Set();

/** `day` is an IST midnight as UTC ms; the hours that day, or null when the office is closed. */
function openHours(day: number, holidays: ReadonlySet<string>, hours: OfficeHoursArg | undefined): OfficeHours | null {
    const d = new Date(day);
    const iso = d.toISOString().slice(0, 10);
    const h = hoursOn(hours, iso);
    return h.weekdays.includes(d.getUTCDay()) && !holidays.has(iso) ? h : null;
}

/** Working minutes in [start, end); 0 when end <= start. */
export function workingMinutesBetween(
    start: Date,
    end: Date,
    holidays: ReadonlySet<string> = NO_HOLIDAYS,
    hours?: OfficeHoursArg,
): number {
    const s = start.getTime() + IST_OFFSET_MS; // IST wall-clock, as UTC ms
    const e = end.getTime() + IST_OFFSET_MS;
    if (!(e > s)) return 0;
    let total = 0;
    let day = Math.floor(s / DAY_MS) * DAY_MS;
    for (let i = 0; day < e && i < MAX_DAYS; i++, day += DAY_MS) {
        const h = openHours(day, holidays, hours);
        if (!h) continue;
        const open = day + h.startHour * HOUR_MS;
        const close = day + h.endHour * HOUR_MS;
        const from = Math.max(open, s);
        const to = Math.min(close, e);
        if (to > from) total += to - from;
    }
    return Math.floor(total / 60000);
}

export function workingHoursBetween(start: Date, end: Date, holidays: ReadonlySet<string> = NO_HOLIDAYS, hours?: OfficeHoursArg): number {
    return workingMinutesBetween(start, end, holidays, hours) / 60;
}

/**
 * Elapsed working time in working DAYS: each open day contributes the share
 * of its office hours that falls in [start, end) — a lead assigned three
 * office hours after it became ready waited 3/9 of a day under 10–19. The
 * unit of the Sales Daily "median wait, sales-ready → assigned". 0 when
 * end <= start.
 */
export function workingDaysElapsed(start: Date, end: Date, holidays: ReadonlySet<string> = NO_HOLIDAYS, hours?: OfficeHoursArg): number {
    const s = start.getTime() + IST_OFFSET_MS;
    const e = end.getTime() + IST_OFFSET_MS;
    if (!(e > s)) return 0;
    let total = 0;
    let day = Math.floor(s / DAY_MS) * DAY_MS;
    for (let i = 0; day < e && i < MAX_DAYS; i++, day += DAY_MS) {
        const h = openHours(day, holidays, hours);
        if (!h) continue;
        const open = day + h.startHour * HOUR_MS;
        const close = day + h.endHour * HOUR_MS;
        const from = Math.max(open, s);
        const to = Math.min(close, e);
        if (to > from) total += (to - from) / (close - open);
    }
    return total;
}

/**
 * The instant `minutes` working minutes after `start` — when a limit in
 * working hours falls due. A start outside office hours begins counting at the
 * next opening. Null past MAX_DAYS (a limit that can never fall due).
 */
export function addWorkingMinutes(
    start: Date,
    minutes: number,
    holidays: ReadonlySet<string> = NO_HOLIDAYS,
    hours?: OfficeHoursArg,
): Date | null {
    let left = Math.max(0, Math.round(minutes)) * MINUTE_MS;
    const s = start.getTime() + IST_OFFSET_MS;
    let day = Math.floor(s / DAY_MS) * DAY_MS;
    for (let i = 0; i < MAX_DAYS; i++, day += DAY_MS) {
        const h = openHours(day, holidays, hours);
        if (!h) continue;
        const open = Math.max(day + h.startHour * HOUR_MS, s);
        const close = day + h.endHour * HOUR_MS;
        if (close <= open) continue;
        if (open + left <= close) return new Date(open + left - IST_OFFSET_MS);
        left -= close - open;
    }
    return null;
}
