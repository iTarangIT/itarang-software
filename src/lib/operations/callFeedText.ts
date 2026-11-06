// ID 229: pure text helpers for the call-feed lines (no database import, so unit-testable).

export type CallFeedKey = "neodove" | "ai_dialer";

export const CALL_FEED_LABEL: Record<CallFeedKey, string> = {
    neodove: "Last NeoDove call received",
    ai_dialer: "Last AI dialer result",
};

/** Two working hours (ID 229). */
export const CALL_FEED_ALARM_WORKING_MINUTES = 120;

/** "5 Nov, 14:32" in IST, or "never". Pure. */
export function istWhen(iso: string | null): string {
    if (!iso) return "never";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    });
}

/** "1 h 40 m" of working time. Pure. */
export function workingGapText(min: number | null): string {
    if (min == null) return "—";
    const h = Math.floor(min / 60);
    const m = min % 60;
    return h > 0 ? `${h} h ${m} m` : `${m} m`;
}
