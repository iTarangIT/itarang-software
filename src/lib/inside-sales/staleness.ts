// Pure-TS working-day age calculation for stale-lead row cues (BRD §0.5).
// Server-side queue route returns last_touchpoint_at + a /api/inside-sales/holidays
// snapshot; the client computes severity from this so the queue route stays cheap.

import {
    isWorkingDay as isOfficeWorkingDay,
    istDay,
    workingDaysSince as officeWorkingDaysSince,
    type OfficeHoursArg,
} from "@/lib/calendar/officeCalendar";
import { TIME_LIMIT_DEFAULTS, type TimeLimits } from "@/lib/timeLimits/registry";

export type StaleSeverity = "normal" | "yellow" | "red" | "critical";

/** The three no-touch cues, in working days — ID 85 time limits (stale_yellow / _red / _critical). */
export type StaleThresholds = { yellow: number; red: number; critical: number };

export const DEFAULT_STALE_THRESHOLDS: StaleThresholds = {
    yellow: TIME_LIMIT_DEFAULTS.stale_yellow,
    red: TIME_LIMIT_DEFAULTS.stale_red,
    critical: TIME_LIMIT_DEFAULTS.stale_critical,
};

type StaleLimits = Pick<
    TimeLimits,
    "stale_yellow" | "stale_red" | "stale_critical" | "stale_yellow_asm" | "stale_red_asm" | "stale_critical_asm"
>;

/**
 * ID 85 #5 (22 Oct) — the no-touch cues for a holder's role: the ASM set
 * (stale_*_asm) for an ASM, the inside-sales set for everyone else (the idle
 * limit's split, idle_asm / idle_cc).
 */
export function staleThresholdsFor(l: StaleLimits, role: string | null | undefined): StaleThresholds {
    return String(role ?? "").toLowerCase() === "asm"
        ? { yellow: l.stale_yellow_asm, red: l.stale_red_asm, critical: l.stale_critical_asm }
        : { yellow: l.stale_yellow, red: l.stale_red, critical: l.stale_critical };
}

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

/**
 * 18 Oct row 33 — the ISR queue's row cue against the inside-sales idle limit
 * (idle_cc, working days, counted from the follow-up ageing basis): "red" =
 * at or past the limit (the "past limit" state, the same rule as Needs
 * Attention and idlePastLimitSql), "critical" = twice the limit or more,
 * "yellow" = the last working day before it. Same severity names as
 * staleSeverity so the row colours are shared.
 */
export function idleSeverity(workingDays: number | null, idleLimit: number): StaleSeverity {
    if (workingDays === null || !(idleLimit > 0)) return "normal";
    const limit = Math.floor(idleLimit);
    if (workingDays >= limit * 2) return "critical";
    if (workingDays >= limit) return "red";
    if (limit > 1 && workingDays >= limit - 1) return "yellow";
    return "normal";
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
