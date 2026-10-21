// Pure-TS working-day age calculation for stale-lead row cues (BRD §0.5).
// Server-side queue route returns last_touchpoint_at + a /api/inside-sales/holidays
// snapshot; the client computes severity from this so the queue route stays cheap.

import {
    isWorkingDay as isOfficeWorkingDay,
    istDay,
    workingDaysSince as officeWorkingDaysSince,
    type OfficeHoursArg,
} from "@/lib/calendar/officeCalendar";
import { TIME_LIMIT_DEFAULTS } from "@/lib/timeLimits/registry";

export type StaleSeverity = "normal" | "yellow" | "red" | "critical";

/** The three no-touch cues, in working days — ID 85 time limits (stale_yellow / _red / _critical). */
export type StaleThresholds = { yellow: number; red: number; critical: number };

export const DEFAULT_STALE_THRESHOLDS: StaleThresholds = {
    yellow: TIME_LIMIT_DEFAULTS.stale_yellow,
    red: TIME_LIMIT_DEFAULTS.stale_red,
    critical: TIME_LIMIT_DEFAULTS.stale_critical,
};

// BRD §0.1: working day = a working weekday (office hours setting, default
// Mon–Sat) that is not a holiday. Since 18 Oct (row 40) these are thin
// wrappers over the ONE office calendar (src/lib/calendar/officeCalendar.ts),
// which counts IST days. The old loop read the BROWSER's weekday (getDay) and
// the UTC date (toISOString), so a lead touched before 05:30 IST aged a day
// early and a viewer outside IST saw other days skipped. Client-safe.

/** True for a working day; `d` is any instant inside the IST day asked about. */
export function isWorkingDay(d: Date, holidayDates: ReadonlySet<string>, hours?: OfficeHoursArg): boolean {
    return isOfficeWorkingDay(istDay(d), holidayDates, hours);
}

/** Working days after the IST day of `from` up to and including the IST day of `to`; 0 when `to` is not later. */
export function workingDaysBetween(from: Date, to: Date, holidayDates: ReadonlySet<string>, hours?: OfficeHoursArg): number {
    if (to.getTime() <= from.getTime()) return 0;
    return officeWorkingDaysSince(from, to, holidayDates, hours);
}

export function workingDaysSince(
    last: Date | string | null,
    holidayDates: ReadonlySet<string>,
    now: Date = new Date(),
    hours?: OfficeHoursArg,
): number | null {
    if (!last) return null;
    const lastDate = typeof last === "string" ? new Date(last) : last;
    if (Number.isNaN(lastDate.getTime())) return null;
    return workingDaysBetween(lastDate, now, holidayDates, hours);
}

// BRD §0.5 visual cue thresholds. The live values come from the server
// (getTimeLimits(), sent with /api/inside-sales/holidays); the default is the
// registry's, for a caller that has not loaded them.
export function staleSeverity(
    workingDays: number | null,
    t: StaleThresholds = DEFAULT_STALE_THRESHOLDS,
): StaleSeverity {
    if (workingDays === null) return "normal";
    if (workingDays >= t.critical) return "critical";
    if (workingDays >= t.red) return "red";
    if (workingDays >= t.yellow) return "yellow";
    return "normal";
}
