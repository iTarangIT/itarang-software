/**
 * Working time between two instants, for limits counted in working HOURS
 * (the Sales Head "Hot leads not called in time" card: first call within 4
 * working hours of the lead reaching its owner).
 *
 * Working hours: Monday–Saturday, 10:00–19:00 IST — the same Mon–Sat week
 * every working-day count in the CRM uses (Sundays off). Holidays are not
 * skipped, as in the admin dashboard's day counts. IST has no DST, so a fixed
 * +05:30 offset is exact. Pure: no I/O, unit-tested.
 */

export const WORK_DAY_START_HOUR = 10;
export const WORK_DAY_END_HOUR = 19;

const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** Past this many calendar days the answer is "far over any limit" anyway. */
const MAX_DAYS = 400;

/** Working minutes in [start, end); 0 when end <= start. */
export function workingMinutesBetween(start: Date, end: Date): number {
    const s = start.getTime() + IST_OFFSET_MS; // IST wall-clock, as UTC ms
    const e = end.getTime() + IST_OFFSET_MS;
    if (!(e > s)) return 0;
    let total = 0;
    let day = Math.floor(s / DAY_MS) * DAY_MS;
    for (let i = 0; day < e && i < MAX_DAYS; i++, day += DAY_MS) {
        if (new Date(day).getUTCDay() === 0) continue; // Sunday
        const open = day + WORK_DAY_START_HOUR * HOUR_MS;
        const close = day + WORK_DAY_END_HOUR * HOUR_MS;
        const from = Math.max(open, s);
        const to = Math.min(close, e);
        if (to > from) total += to - from;
    }
    return Math.floor(total / 60000);
}

export function workingHoursBetween(start: Date, end: Date): number {
    return workingMinutesBetween(start, end) / 60;
}
