/**
 * GSTIN — the key that ties a dealer's invoices back to the CRM (review R-11).
 *
 * Invoices carry the customer's GSTIN; CRM leads now must carry it from the
 * moment they are marked Converted. revenueSource.ts matches the two with the
 * same normalisation in SQL (GSTIN_KEY): spaces removed, upper-cased.
 *
 * Two checks (tracker ID 62): the standard 15-character shape — 2-digit state
 * code, 10-character PAN, entity number, 'Z', check character — and the check
 * character itself (mod-36 over the first 14). A typo that keeps the shape
 * used to be found only when no invoice ever matched; now it is refused where
 * it is typed or read. CLIENT-SAFE: no db import.
 */

export const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/;

const GSTIN_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** iTarang's own registrations — a seller, never a customer. */
export const ITARANG_GSTINS = ["06AALFI7813E1ZE", "07AALFI7813E1ZC"] as const;

/** Upper-case and strip all whitespace. '' stays ''. */
export function normalizeGstin(value: string | null | undefined): string {
    return (value ?? "").replace(/\s+/g, "").toUpperCase();
}

/** The 15th character the first 14 imply, or null when they are not GSTIN characters. */
export function gstinCheckDigit(first14: string): string | null {
    if (first14.length !== 14) return null;
    let sum = 0;
    for (let i = 0; i < 14; i++) {
        const v = GSTIN_CHARS.indexOf(first14[i]);
        if (v < 0) return null;
        const p = v * (i % 2 === 0 ? 1 : 2);
        sum += Math.floor(p / 36) + (p % 36);
    }
    return GSTIN_CHARS[(36 - (sum % 36)) % 36];
}

export type GstinCheck = "ok" | "bad_shape" | "bad_check_digit";

export function checkGstin(value: string | null | undefined): GstinCheck {
    const g = normalizeGstin(value);
    if (!GSTIN_RE.test(g)) return "bad_shape";
    return gstinCheckDigit(g.slice(0, 14)) === g[14] ? "ok" : "bad_check_digit";
}

export function isValidGstin(value: string | null | undefined): boolean {
    return checkGstin(value) === "ok";
}

export function isOwnGstin(value: string | null | undefined): boolean {
    return (ITARANG_GSTINS as readonly string[]).includes(normalizeGstin(value));
}

/** A GSTIN offered as a CUSTOMER's: valid, and not one of iTarang's own. */
export function checkCustomerGstin(value: string | null | undefined): GstinCheck | "own_gstin" {
    const c = checkGstin(value);
    if (c !== "ok") return c;
    return isOwnGstin(value) ? "own_gstin" : "ok";
}

/**
 * ID 62 — a customer GSTIN read off a document (invoice PDF, Vyapar register,
 * Zoho). One that fails is dropped so it can never match a dealer, and comes
 * back as a Needs-attention sentence (attentionReasons.ts parses these exact
 * openings into customer_gstin_invalid / customer_gstin_own) — never silently.
 */
export function screenCustomerGstin(raw: string | null | undefined): {
    gstin: string | null;
    attention: string | null;
} {
    const g = normalizeGstin(raw);
    if (!g) return { gstin: null, attention: null };
    const check = checkCustomerGstin(g);
    if (check === "ok") return { gstin: g, attention: null };
    return {
        gstin: null,
        attention:
            check === "own_gstin"
                ? `Customer GSTIN is iTarang's own (${g}) — not matched to a dealer.`
                : `Customer GSTIN is not valid (${g}) — not matched to a dealer.`,
    };
}

export const GSTIN_CHECK_MESSAGE: Record<Exclude<ReturnType<typeof checkCustomerGstin>, "ok">, string> = {
    bad_shape: "Enter a valid 15-character GSTIN.",
    bad_check_digit: "This GSTIN's last character does not match — check it for a typing mistake.",
    own_gstin: "This is iTarang's own GSTIN, not the dealer's.",
};
