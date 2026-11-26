/**
 * NeoDove status codes → names (ID 242, 26 Nov 2026). Pure: no I/O.
 *
 * NeoDove sends every call's status as a number (`lead_status`) and, since
 * about 23–26 Oct, also its name (`lead_status_name`). Before that, 878 calls
 * on live (codes 5 and 6) arrived with the number only, and the CRM showed
 * "status code 6" — the "CRM shows only a code" row of the 242 check.
 *
 * THE TABLE IS MEASURED, NOT GUESSED: it is every code NeoDove sent to live in
 * the 60 days to 26 Nov with the NAME it sent alongside (242 Q1, run read-only
 * on database-2, 26 Nov). NeoDove renamed some statuses around 23–26 Oct
 * (Open → Uncontacted, Follow-Up → In-Progress, Closed → Lost); the table
 * carries the CURRENT name, the one NeoDove's own screens show today.
 *
 *   code  name now      older name   calls seen (60 days)
 *   1     Uncontacted   Open         3,550
 *   2     Uncontacted   Open           354
 *   5     In-Progress   (none sent)  1,141
 *   6     In-Progress   (none sent)  2,002
 *   -5    In-Progress   Follow-Up      164
 *   -6    In-Progress   Follow-Up      128
 *   7     Lost          Closed         338
 *   8     Lost          Closed           2
 *   10    Converted     Closed           5
 *
 * A code NOT in the table is shown as "NeoDove code N", never guessed.
 */

export const NEODOVE_STATUS_CODE_NAMES: Readonly<Record<string, string>> = {
    "1": "Uncontacted",
    "2": "Uncontacted",
    "5": "In-Progress",
    "6": "In-Progress",
    "-5": "In-Progress",
    "-6": "In-Progress",
    "7": "Lost",
    "8": "Lost",
    "10": "Converted",
};

/** A real NeoDove status code is a (possibly negative) number. */
const isNumericCode = (c: string) => /^-?\d+$/.test(c);

/**
 * The name NeoDove sent, else the table's name for its code, else null.
 *
 * NeoDove's CSV export (the 3 Aug reconciliation import, ~1,200 calls) puts the
 * status NAME ("In-Progress", "Lost") where the webhook puts the code; a value
 * that is not a number is therefore already the name.
 */
export function neodoveStatusName(code: string | null | undefined, sentName: string | null | undefined): string | null {
    const name = (sentName ?? "").trim();
    if (name) return name;
    const c = (code ?? "").trim();
    if (!c) return null;
    return isNumericCode(c) ? (NEODOVE_STATUS_CODE_NAMES[c] ?? null) : c;
}

/** "In-Progress", or "NeoDove code 12" for a code outside the table, or null when there is no status at all. */
export function neodoveStatusLabel(code: string | null | undefined, sentName: string | null | undefined): string | null {
    const name = neodoveStatusName(code, sentName);
    if (name) return name;
    const c = (code ?? "").trim();
    return c ? `NeoDove code ${c}` : null;
}

/**
 * NeoDove's follow-up date. It arrives as `follow_up_date` (epoch millis, as a
 * number or a string) and, on newer messages, also `follow_up_date_time`
 * ("27/11/2026, 11:00 am", IST). Codes 5 and 6 carry it on every live message;
 * the CRM ignored it until now ("NeoDove sent it, CRM ignores it" in 242).
 */
export function parseNeodoveFollowUp(epoch: unknown, text: unknown): Date | null {
    const n = typeof epoch === "number" ? epoch : typeof epoch === "string" && /^\d{10,13}$/.test(epoch.trim()) ? Number(epoch.trim()) : NaN;
    if (Number.isFinite(n) && n > 0) {
        const d = new Date(n < 1e12 ? n * 1000 : n);
        if (!Number.isNaN(d.getTime())) return d;
    }
    if (typeof text === "string") {
        // DD/MM/YYYY, HH:MM am|pm — IST.
        const m = text.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s+(\d{1,2}):(\d{2})\s*(am|pm)?$/i);
        if (m) {
            let h = Number(m[4]);
            const ap = (m[6] ?? "").toLowerCase();
            if (ap === "pm" && h < 12) h += 12;
            if (ap === "am" && h === 12) h = 0;
            const iso = `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}T${String(h).padStart(2, "0")}:${m[5]}:00+05:30`;
            const d = new Date(iso);
            if (!Number.isNaN(d.getTime())) return d;
        }
    }
    return null;
}

/** "27 Nov 2026, 11:00 am" in IST. */
export function istDateTime(d: Date): string {
    return d.toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
    });
}

/**
 * A stored "[NeoDove] Disposition: status code 6 · …" line made readable for
 * the screen: "Disposition: In-Progress (NeoDove code 6)". The stored text is
 * never rewritten (no backfill on live); old lines read right wherever they are
 * shown. A line without the code pattern comes back unchanged.
 */
export function readableNeodoveRemarks(remarks: string | null | undefined): string | null {
    if (remarks == null) return null;
    if (!remarks.startsWith("[NeoDove]")) return remarks;
    return remarks.replace(/status code (-?\d+)/g, (_m, code: string) => {
        const name = NEODOVE_STATUS_CODE_NAMES[code];
        return name ? `${name} (NeoDove code ${code})` : `NeoDove code ${code}`;
    });
}
