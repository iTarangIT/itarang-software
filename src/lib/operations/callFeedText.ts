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

/** The ops metric behind the call-feed alarm (registry.ts). */
export const CALL_FEED_METRIC = "calls.feed_gap";

/**
 * Named logins that also get the call-feed alarm, matched by email whatever
 * their role. Empty since 6 Nov (the CEO and the Sales Head only).
 */
export const CALL_FEED_ALERT_LOGINS: string[] = [];

/**
 * Who hears a call-feed alarm on the live CRM (6 Nov, final): bell and email
 * to every CEO and Sales Head login; the ops bell as before. The sandbox gets
 * no NeoDove calls by design, so there it stays an ops-only bell. Pure.
 */
export function callFeedAlertAudience(
    metricKey: string,
    appUrl: string | null | undefined,
): { bellRoles: string[]; emailRoles: string[]; logins: string[] } {
    const live = (appUrl ?? "").includes("crm.itarang.com");
    if (metricKey !== CALL_FEED_METRIC || !live) return { bellRoles: ["operations"], emailRoles: [], logins: [] };
    return {
        bellRoles: ["operations", "ceo", "sales_head"],
        emailRoles: ["ceo", "sales_head"],
        logins: CALL_FEED_ALERT_LOGINS,
    };
}

/** Test logins (e2e-…@) never get the alarm email. Pure. */
export function isTestMailbox(email: string): boolean {
    return /^e2e[-_.]/i.test(email.trim());
}

/** Plain-words subject and body for the call-feed alarm email. Pure. */
export function callFeedAlertEmail(
    severity: "warn" | "crit" | "resolved",
    source: string,
    message: string,
): { subject: string; text: string } {
    const feed = source === "ai_dialer" ? "AI dialer results" : source === "neodove" ? "NeoDove calls" : source;
    if (severity === "resolved") {
        return {
            subject: `[iTarang CRM] ${feed} are reaching the CRM again`,
            text: `${feed} are reaching the live CRM again.\n\n${message}\n\nOps Console: https://crm.itarang.com/operations/alerts`,
        };
    }
    const hours = severity === "crit" ? 4 : 2;
    const what =
        source === "neodove"
            ? `Leads pushed to NeoDove have had no update back for over ${hours} working hours. NeoDove may have a problem, or its webhook may have been changed`
            : `No ${feed} have reached the live CRM for over ${hours} working hours`;
    return {
        subject: `[iTarang CRM] ${severity === "crit" ? "Urgent" : "Warning"}: no ${feed} for over ${hours} working hours`,
        text:
            `${what}.\n\n${message}\n\n` +
            (source === "ai_dialer"
                ? "Check that the AI dialer is running."
                : "Check in NeoDove that the webhook still points at https://crm.itarang.com (not the sandbox).") +
            `\n\nOps Console: https://crm.itarang.com/operations/alerts`,
    };
}
