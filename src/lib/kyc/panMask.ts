// PAN masking for API responses (tracker ID 119, with the ID 166 rule of 10 Oct).
//
// Full Aadhaar never leaves the server (aadhaarMask.ts). The full PAN goes only
// to Admin, the Sales Head, the CEO and the owner of the lead (its dealer, the
// person who uploaded it, the account owner) — the same people who may open
// the customer's KYC files. Everyone else gets `XXXXXX234F`.
//
// As with Aadhaar, the borrower form round-trips what it loaded back to the
// save routes, so a masked PAN can come BACK in a save: restoreMaskedPan()
// keeps the stored value instead of overwriting it with the mask. Pure: no db.

const PAN = /^[A-Z]{5}[0-9]{4}[A-Z]$/i;

/** Does this look like a PAN (`ABCDE1234F`)? */
export function isPan(value: unknown): boolean {
    return typeof value === "string" && PAN.test(value.trim());
}

/** Does this look like a value maskPan() produced? */
export function isMaskedPan(value: unknown): boolean {
    return typeof value === "string" && /^[Xx*]{6}[0-9]{3}[A-Za-z]$/.test(value.trim());
}

/** `XXXXXX234F` for a PAN; null/empty stays null; anything else passes through. */
export function maskPan(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    const raw = String(value).trim();
    if (!raw) return null;
    if (!isPan(raw)) return isMaskedPan(raw) ? raw : raw.length > 4 ? `XXXXXX${raw.slice(-4)}` : "XXXXXXXXXX";
    return `XXXXXX${raw.slice(-4).toUpperCase()}`;
}

/**
 * A copy of `value` with every PAN-shaped string masked, at any depth. Matched
 * on the VALUE (the PAN format is distinctive), so OCR blobs and provider
 * responses that name the field `id_number` or `pan` are covered too.
 */
export function maskPanDeep<T>(value: T): T {
    return walk(value) as T;
}

function walk(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object" && !(value instanceof Date)) {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = walk(v);
        return out;
    }
    return isPan(value) ? maskPan(value) : value;
}

/** The PAN to SAVE: the incoming one, unless it is the mask — then the stored one. */
export function restoreMaskedPan(incoming: unknown, stored: unknown): unknown {
    return isMaskedPan(incoming) ? (stored ?? null) : incoming;
}

/** restoreMaskedPan() over a whole object (a saved-back draft blob), path by path. */
export function restoreMaskedPanDeep<T>(incoming: T, stored: unknown): T {
    return restoreWalk(incoming, stored) as T;
}

function restoreWalk(incoming: unknown, stored: unknown): unknown {
    if (isMaskedPan(incoming)) return stored ?? null;
    if (Array.isArray(incoming)) {
        const s = Array.isArray(stored) ? stored : [];
        return incoming.map((v, i) => restoreWalk(v, s[i]));
    }
    if (incoming && typeof incoming === "object" && !(incoming instanceof Date)) {
        const s = stored && typeof stored === "object" ? (stored as Record<string, unknown>) : {};
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(incoming as Record<string, unknown>)) out[k] = restoreWalk(v, s[k]);
        return out;
    }
    return incoming;
}
