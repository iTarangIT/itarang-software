// ID 224 (point 1) — every download states the real dates it covers.
//
// With no dates picked most datasets cover THIS MONTH, but the file said only
// "Filters: None — the default range", so an empty "Customer loan files" (no
// file reached review 1-3 Nov) read as "there are none". And "this month" had
// no end, so Visits listed bookings in December and January.
//
// The rule, shared by the SQL (registry.ts dayRange), the file's "About this
// file" sheet, the CSV file name and the page's pre-filled date boxes:
//   - nothing picked: this month, 1st → today (IST); or every row for the
//     datasets marked allWhenNoDates (Leads, Inventory);
//   - only From: From → today;
//   - only To: everything up to To;
//   - datasets without dates (Dealer accounts, Targets) say so.
// Pure and client-safe: no imports.

export type RangeInfo = {
    id: string;
    dateFields: { value: string; label: string }[];
    allWhenNoDates?: boolean;
};

export type EffectiveRange = {
    mode: "picked" | "month" | "all" | "none";
    from: string | null;
    to: string | null;
    /** One line for the file: "1 Nov – 5 Nov 2026: this month, no dates picked". */
    text: string;
};

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Today's date in IST, YYYY-MM-DD. */
export function istToday(now: Date = new Date()): string {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(now);
}

/** The 1st of `today`'s month. */
export function monthStart(today: string): string {
    return `${today.slice(0, 8)}01`;
}

/** "2026-11-05" → "5 Nov 2026". */
export function dayLabel(d: string): string {
    const [y, m, day] = d.split("-");
    return `${Number(day)} ${MONTHS[Number(m) - 1] ?? m} ${y}`;
}

/** "1 Nov – 5 Nov 2026", or "1 Apr 2026 – 5 Nov 2026" across years. */
export function spanLabel(from: string, to: string): string {
    const a = dayLabel(from);
    const b = dayLabel(to);
    if (from.slice(0, 4) === to.slice(0, 4)) return `${a.replace(/ \d{4}$/, "")} – ${b}`;
    return `${a} – ${b}`;
}

function fieldLabel(info: RangeInfo, params: Record<string, string>): string {
    const f = info.dateFields.find((d) => d.value === params.date_field) ?? info.dateFields[0];
    return f ? f.label.toLowerCase() : "date";
}

export function effectiveRange(info: RangeInfo, params: Record<string, string>, today: string): EffectiveRange {
    if (info.dateFields.length === 0) {
        if (info.id === "targets") {
            const m = /^\d{4}-(0[1-9]|1[0-2])$/.test(params.month ?? "") ? params.month : today.slice(0, 7);
            const [y, mm] = m.split("-");
            const label = `${MONTHS[Number(mm) - 1]} ${y}`;
            return { mode: "none", from: null, to: null, text: `${label}${params.month ? "" : " (this month; no month picked)"}` };
        }
        return { mode: "none", from: null, to: null, text: "Not date-ranged: every row as it stands today." };
    }
    const from = params.from && ISO.test(params.from) ? params.from : null;
    const to = params.to && ISO.test(params.to) ? params.to : null;
    const by = fieldLabel(info, params);
    if (from || to) {
        if (from && !to) return { mode: "picked", from, to: today, text: `${spanLabel(from, today)} (by ${by}; no end date picked, so up to today)` };
        if (!from && to) return { mode: "picked", from: null, to, text: `Everything up to ${dayLabel(to)} (by ${by})` };
        return { mode: "picked", from, to, text: `${spanLabel(from!, to!)} (by ${by})` };
    }
    if (info.allWhenNoDates) return { mode: "all", from: null, to: null, text: `All dates: no dates picked (by ${by})` };
    const start = monthStart(today);
    return { mode: "month", from: start, to: today, text: `${spanLabel(start, today)}: this month, no dates picked (by ${by})` };
}

/** The dates the page pre-fills for a dataset: this month to today, or none. */
export function defaultDates(info: RangeInfo, today: string): { from: string; to: string } | null {
    if (info.dateFields.length === 0 || info.allWhenNoDates) return null;
    return { from: monthStart(today), to: today };
}

/** File-name tag for the range: "2026-11-01_to_2026-11-05", "all-dates", "" when not ranged. */
export function rangeFileTag(r: EffectiveRange): string {
    if (r.mode === "none") return "";
    if (r.mode === "all") return "all-dates";
    return `${r.from ?? "start"}_to_${r.to ?? "end"}`;
}
