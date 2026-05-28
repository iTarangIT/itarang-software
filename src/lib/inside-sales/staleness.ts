// Pure-TS working-day age calculation for stale-lead row cues (BRD §0.5).
// Server-side queue route returns last_touchpoint_at + a /api/inside-sales/holidays
// snapshot; the client computes severity from this so the queue route stays cheap.

export type StaleSeverity = "normal" | "yellow" | "red" | "critical";

const SUNDAY = 0;

// BRD §0.1: working day = Mon–Sat excluding holidays. Sundays always excluded.
export function isWorkingDay(d: Date, holidayDates: Set<string>): boolean {
    const dow = d.getDay();
    if (dow === SUNDAY) return false;
    const isoDate = d.toISOString().slice(0, 10);
    if (holidayDates.has(isoDate)) return false;
    return true;
}

// Counts working days between two dates (exclusive of `from`, inclusive of `to`).
export function workingDaysBetween(
    from: Date,
    to: Date,
    holidayDates: Set<string>,
): number {
    if (to.getTime() <= from.getTime()) return 0;
    const cursor = new Date(from);
    cursor.setUTCHours(0, 0, 0, 0);
    const end = new Date(to);
    end.setUTCHours(0, 0, 0, 0);
    let days = 0;
    while (cursor.getTime() < end.getTime()) {
        cursor.setUTCDate(cursor.getUTCDate() + 1);
        if (isWorkingDay(cursor, holidayDates)) days++;
    }
    return days;
}

export function workingDaysSince(
    last: Date | string | null,
    holidayDates: Set<string>,
    now: Date = new Date(),
): number | null {
    if (!last) return null;
    const lastDate = typeof last === "string" ? new Date(last) : last;
    if (Number.isNaN(lastDate.getTime())) return null;
    return workingDaysBetween(lastDate, now, holidayDates);
}

// BRD §0.5 visual cue thresholds.
export function staleSeverity(workingDays: number | null): StaleSeverity {
    if (workingDays === null) return "normal";
    if (workingDays >= 14) return "critical";
    if (workingDays >= 10) return "red";
    if (workingDays >= 5) return "yellow";
    return "normal";
}
