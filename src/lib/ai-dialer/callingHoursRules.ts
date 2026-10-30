// ID 85 (decided 30 Oct): Admin and the Sales Head may change the AI calling
// hours, but every change needs a reason and goes in a log the CEO can read
// (the office-hours rule, src/lib/calendar/officeHoursStore.ts). Pure, so it
// is unit-tested; ./callingHoursLog.ts writes and reads the log.

/** The reason shown in the log must say something. */
export const CALLING_HOURS_REASON_MIN = 3;
export const CALLING_HOURS_REASON_MESSAGE = "Give a reason for the change (shown in the log the CEO reads).";

export type CallingHours = {
    start: string | null;
    end: string | null;
    /** Weekday codes ("mon" … "sun"); null = not part of this change. */
    days: string[] | null;
};

/** null when the reason is fine, else the message to show. */
export function callingHoursReasonError(reason: string | null | undefined): string | null {
    return (reason ?? "").trim().length < CALLING_HOURS_REASON_MIN ? CALLING_HOURS_REASON_MESSAGE : null;
}

/** Did the hours (or, when given, the days) change? */
export function callingHoursChanged(before: CallingHours | null, after: CallingHours): boolean {
    if (!before) return true;
    if (before.start !== after.start || before.end !== after.end) return true;
    if (after.days == null) return false;
    const a = [...(before.days ?? [])].sort().join(",");
    const b = [...after.days].sort().join(",");
    return a !== b;
}

/** "10:00–19:00 · Mon–Sat" style text for the log table. */
export function callingHoursText(h: CallingHours | null): string {
    if (!h || (!h.start && !h.end)) return "—";
    const hours = `${h.start ?? "?"}–${h.end ?? "?"}`;
    return h.days && h.days.length ? `${hours} · ${h.days.map((d) => d.charAt(0).toUpperCase() + d.slice(1)).join(", ")}` : hours;
}
