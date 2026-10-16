// Human wording for CRM values — channel-agnostic, used by previews (core) and
// the WhatsApp renderer. Dates are IST with FIXED day/month names: ICU builds
// differ between hosts ("Sep" vs "Sept"), and a preview must read the same
// everywhere it is shown.

import { LEAD_STATUS_LABEL } from "@/lib/leads/queueFilters";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const IST_PARTS = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
});

function istParts(d: Date) {
    const p = Object.fromEntries(IST_PARTS.formatToParts(d).map((x) => [x.type, x.value]));
    const y = Number(p.year);
    const m = Number(p.month);
    const day = Number(p.day);
    const weekday = new Date(Date.UTC(y, m - 1, day)).getUTCDay();
    return {
        label: `${DAYS[weekday]} ${day} ${MONTHS[m - 1]}`,
        time: `${p.hour.padStart(2, "0")}:${p.minute.padStart(2, "0")}`,
    };
}

/** "2026-09-26" → "Sat 26 Sep"; a timestamp → "Sat 26 Sep, 11:00" (IST). */
export function fmtDate(v: string | Date | null | undefined): string | null {
    if (!v) return null;
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
        return istParts(new Date(`${v}T12:00:00+05:30`)).label;
    }
    const d = v instanceof Date ? v : new Date(v);
    if (Number.isNaN(d.getTime())) return String(v);
    const { label, time } = istParts(d);
    return `${label}, ${time}`;
}

/** The IST day only — a date or a timestamp → "Sat 26 Sep". */
export function fmtDay(v: string | Date | null | undefined): string | null {
    if (!v) return null;
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return fmtDate(v);
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? String(v) : istParts(d).label;
}

const IST_OFFSET_MS = 330 * 60_000;

/**
 * A timestamp as IST ISO-8601 with its offset — "2026-10-15T10:00:00+05:30" —
 * so the model reads the rep's wall clock, never UTC it must convert. Accepts a
 * Date, an ISO string or Postgres text ("2026-09-19 08:35:08.84+00"). A
 * date-only "YYYY-MM-DD" is returned unchanged (it has no time to shift);
 * null / "" → null; anything unparseable is returned as text.
 */
export function istIso(v: unknown): string | null {
    if (v == null || v === "") return null;
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
    const d =
        v instanceof Date
            ? v
            : new Date(String(v).replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));
    if (Number.isNaN(d.getTime())) return String(v);
    return `${new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 19)}+05:30`;
}

/**
 * The CRM screens' own status label (LEAD_STATUS_LABEL — "Assigned",
 * "Awaiting field visit", "Won — onboarding"); an unknown code reads with its
 * underscores as spaces; null → "none".
 */
export function statusLabel(s: string | null | undefined): string {
    if (!s) return "none";
    return (LEAD_STATUS_LABEL as Record<string, string>)[s] ?? s.replace(/_/g, " ");
}

/** "price_high" → "price high". */
export function reasonLabel(r: string | null | undefined): string {
    return r ? r.replace(/_/g, " ") : "";
}
