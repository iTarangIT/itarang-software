// Elapsed WORKING time between two instants, in working days — the unit the
// Daily Sales design uses for "median wait, sales-ready → assigned" and its
// limit ("others 2 working days"). A working day is an IST calendar day that is
// not a Sunday and not in holiday_calendar: the same rule as the targets
// register (targets/rules.workingDaysBetween), but counting the hours actually
// elapsed, so a lead assigned 9 hours after it became ready waited 0.4 days.
//
// Pure — the holidays come in as a set of YYYY-MM-DD strings.

const IST_OFFSET_MS = 5.5 * 3600_000;
const DAY_MS = 86_400_000;

/** IST calendar date of an instant, YYYY-MM-DD. */
function istDate(ms: number): string {
    return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function isWorkingDay(isoDate: string, holidays: ReadonlySet<string>): boolean {
    return new Date(`${isoDate}T00:00:00Z`).getUTCDay() !== 0 && !holidays.has(isoDate);
}

export function workingDaysElapsed(from: Date, to: Date, holidays: ReadonlySet<string>): number {
    let start = from.getTime();
    const end = to.getTime();
    if (!(end > start)) return 0;
    let ms = 0;
    while (start < end) {
        // End of this IST day, as an instant.
        const dayStartIst = Math.floor((start + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS;
        const next = Math.min(end, dayStartIst + DAY_MS);
        if (isWorkingDay(istDate(start), holidays)) ms += next - start;
        start = next;
    }
    return ms / DAY_MS;
}

/** Median of a list (null when empty). */
export function median(values: number[]): number | null {
    if (values.length === 0) return null;
    const s = [...values].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
