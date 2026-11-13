// AI Analyst — when a conversation or message happened, in IST. Client-safe (no imports).

const FULL = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
});

const TIME = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" });
const DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }); // YYYY-MM-DD

function toDate(at: string | number | Date | null | undefined): Date | null {
    if (at === null || at === undefined || at === "") return null;
    const d = at instanceof Date ? at : new Date(at);
    return Number.isNaN(d.getTime()) ? null : d;
}

/** "13 Nov 2026, 4:22 pm" (IST), or "" when there is no usable time. */
export function formatWhen(at: string | number | Date | null | undefined): string {
    const d = toDate(at);
    return d ? FULL.format(d) : "";
}

/**
 * Short form for a list: "Today, 4:22 pm", "Yesterday, 9:05 am", else the full date and time.
 * `now` is a parameter so it can be tested.
 */
export function formatWhenShort(at: string | number | Date | null | undefined, now: Date = new Date()): string {
    const d = toDate(at);
    if (!d) return "";
    const day = DAY.format(d);
    if (day === DAY.format(now)) return `Today, ${TIME.format(d)}`;
    if (day === DAY.format(new Date(now.getTime() - 86_400_000))) return `Yesterday, ${TIME.format(d)}`;
    return FULL.format(d);
}
