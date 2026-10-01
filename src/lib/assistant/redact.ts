// Invariant 8 — Aadhaar, PAN, bank details and date of birth never leave the
// CRM over WhatsApp, even when a tool result would contain them.
//
// Two layers, both in the TOOL layer (not the renderer), so neither the model
// nor any channel ever holds the value:
//   1. Tools project an ALLOWLIST of fields — sensitive columns are never
//      selected into a result in the first place.
//   2. redactDeep() scrubs every free-text string in a result: remarks and
//      notes are typed by people and can contain anything.
//
// The number rule is deliberately blunt: any run of 9+ digits is masked unless
// it is shaped like an Indian mobile (10 digits starting 6–9, optionally with a
// literal +91). A contiguous 12-digit "91…" is masked too, because an Aadhaar
// can start with 9 and a leak is worse than a masked phone. Dealer phones for
// leads in scope travel in the `phone` field, which is exempt.

const MASK = "[redacted]";

const RULES: [RegExp, string][] = [
    // Aadhaar written 4-4-4 (spaces or hyphens) — the usual way.
    [/\b\d{4}[ -]\d{4}[ -]\d{4}\b/g, MASK],
    // PAN.
    [/\b[A-Za-z]{5}\d{4}[A-Za-z]\b/g, MASK],
    // IFSC.
    [/\b[A-Za-z]{4}0[A-Za-z0-9]{6}\b/g, MASK],
    // Date of birth: a date that follows a DOB word.
    [
        /\b(dob|d\.o\.b\.?|date of birth|birth ?date|born on|janam ?tithi|janm ?tithi)\b[^0-9]{0,15}\d{1,4}[/\-.]\d{1,2}[/\-.]\d{1,4}/gi,
        "$1 " + MASK,
    ],
];

const LONG_NUMBER = /(\+?)(\d{9,18})/g;

function maskLongNumbers(s: string): string {
    return s.replace(LONG_NUMBER, (whole, plus: string, digits: string) => {
        const mobile = /^[6-9]\d{9}$/.test(digits);
        const plus91Mobile = plus === "+" && /^91[6-9]\d{9}$/.test(digits);
        return mobile || plus91Mobile ? whole : `${plus}${MASK}`;
    });
}

export function redactText(s: string): string {
    let out = s;
    for (const [re, rep] of RULES) out = out.replace(re, rep);
    return maskLongNumbers(out);
}

/** Keys whose values are identifiers or links, never free text. */
const EXEMPT_KEYS = new Set(["id", "lead_id", "action_id", "crm_url", "phone", "owner_id", "tab"]);

/** Scrub every string leaf of a JSON-ish value, except the exempt keys. */
export function redactDeep<T>(value: T, key?: string): T {
    if (typeof value === "string") {
        return (key && EXEMPT_KEYS.has(key) ? value : redactText(value)) as T;
    }
    if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as T;
    if (value && typeof value === "object" && !(value instanceof Date)) {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactDeep(v, k);
        return out as T;
    }
    return value;
}

/** Keep only `keys` of a row — the allowlist half of Invariant 8. */
export function pick<T extends Record<string, unknown>, K extends keyof T>(row: T, keys: readonly K[]): Pick<T, K> {
    const out = {} as Pick<T, K>;
    for (const k of keys) if (k in row) out[k] = row[k];
    return out;
}
