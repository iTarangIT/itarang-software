/**
 * Working time between two instants, for limits counted in working HOURS
 * (ID 86 clocks; the Sales Head "Hot leads not called in time" card).
 *
 * Working hours: Monday–Saturday, 10:00–19:00 IST — the office calendar
 * (src/lib/calendar/officeCalendar.ts). Pass the active holidays (IST
 * YYYY-MM-DD, loadHolidays()) to skip them; without the set only Sundays are
 * off. IST has no DST, so a fixed +05:30 offset is exact. Pure: no I/O,
 * unit-tested.
 */

export const WORK_DAY_START_HOUR = 10;
export const WORK_DAY_END_HOUR = 19;

const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
/** Past this many calendar days the answer is "far over any limit" anyway. */
const MAX_DAYS = 400;

const NO_HOLIDAYS: ReadonlySet<string> = new Set();

/** `day` is an IST midnight as UTC ms; true when the office is open that day. */
function isOpenDay(day: number, holidays: ReadonlySet<string>): boolean {
    const d = new Date(day);
    return d.getUTCDay() !== 0 && !holidays.has(d.toISOString().slice(0, 10));
}

/** Working minutes in [start, end); 0 when end <= start. */
export function workingMinutesBetween(start: Date, end: Date, holidays: ReadonlySet<string> = NO_HOLIDAYS): number {
    const s = start.getTime() + IST_OFFSET_MS; // IST wall-clock, as UTC ms
    const e = end.getTime() + IST_OFFSET_MS;
    if (!(e > s)) return 0;
    let total = 0;
    let day = Math.floor(s / DAY_MS) * DAY_MS;
    for (let i = 0; day < e && i < MAX_DAYS; i++, day += DAY_MS) {
        if (!isOpenDay(day, holidays)) continue;
        const open = day + WORK_DAY_START_HOUR * HOUR_MS;
        const close = day + WORK_DAY_END_HOUR * HOUR_MS;
        const from = Math.max(open, s);
        const to = Math.min(close, e);
        if (to > from) total += to - from;
    }
    return Math.floor(total / 60000);
}

export function workingHoursBetween(start: Date, end: Date, holidays: ReadonlySet<string> = NO_HOLIDAYS): number {
    return workingMinutesBetween(start, end, holidays) / 60;
}

/**
 * The instant `minutes` working minutes after `start` — when a limit in
 * working hours falls due. A start outside office hours begins counting at the
 * next opening. Null past MAX_DAYS (a limit that can never fall due).
 */
export function addWorkingMinutes(start: Date, minutes: number, holidays: ReadonlySet<string> = NO_HOLIDAYS): Date | null {
    let left = Math.max(0, Math.round(minutes)) * MINUTE_MS;
    const s = start.getTime() + IST_OFFSET_MS;
    let day = Math.floor(s / DAY_MS) * DAY_MS;
    for (let i = 0; i < MAX_DAYS; i++, day += DAY_MS) {
        if (!isOpenDay(day, holidays)) continue;
        const open = Math.max(day + WORK_DAY_START_HOUR * HOUR_MS, s);
        const close = day + WORK_DAY_END_HOUR * HOUR_MS;
        if (close <= open) continue;
        if (open + left <= close) return new Date(open + left - IST_OFFSET_MS);
        left -= close - open;
    }
    return null;
}
