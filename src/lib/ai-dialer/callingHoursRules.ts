// ID 85 — the AI calling hours follow the time-limit rule (Kartik, 10 Oct):
// Admin only, every change needs a reason and goes in a log the CEO reads,
// and a change can be dated to start on a later day (5 Nov; it used to be the
// Admin and the Sales Head, effective at once). Pure, so it is unit-tested;
// ./callingHoursLog.ts writes and reads the log and applies a dated change.

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


const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** null when the start day is fine (today or later, IST), else the message. */
export function effectiveFromError(day: string | null | undefined, today: string): string | null {
    if (!day) return null;
    if (!ISO_DAY.test(day)) return "Pick the day the new hours start.";
    return day < today ? "The new hours cannot start on a day that has passed." : null;
}

export type ScheduledHours = { id: string; effectiveFrom: string; createdAt: string; hours: CallingHours };

/**
 * The dated change that is due on `today`: among the scheduled changes not yet
 * applied, the one with the latest start day on or before today (a later
 * change made for the same day wins). null when none is due.
 */
export function dueScheduledHours(rows: ScheduledHours[], today: string): ScheduledHours | null {
    const due = rows.filter((r) => ISO_DAY.test(r.effectiveFrom) && r.effectiveFrom <= today);
    if (!due.length) return null;
    return due.sort((a, b) => (a.effectiveFrom === b.effectiveFrom ? a.createdAt.localeCompare(b.createdAt) : a.effectiveFrom.localeCompare(b.effectiveFrom))).at(-1)!;
}
