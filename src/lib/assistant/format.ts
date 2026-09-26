// Human wording for CRM values — channel-agnostic, used by previews (core) and
// the WhatsApp renderer. Dates are IST with FIXED day/month names: ICU builds
// differ between hosts ("Sep" vs "Sept"), and a preview must read the same
// everywhere it is shown.

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

/** "Under_Discussion" → "Under Discussion"; null → "none". */
export function statusLabel(s: string | null | undefined): string {
    return s ? s.replace(/_/g, " ") : "none";
}

/** "price_high" → "price high". */
export function reasonLabel(r: string | null | undefined): string {
    return r ? r.replace(/_/g, " ") : "";
}
