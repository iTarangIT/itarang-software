// Pure dedupe rules — NO imports, no DB, no I/O.
//
// Split out of dedupe.ts so these can be unit-tested. vitest.config.ts scopes
// the suite to pure no-I/O modules, and `@/lib/db` throws at import time when
// DATABASE_URL is unset (and opens a real connection pool when it isn't), so a
// test importing dedupe.ts directly would either fail or connect to a live
// database to test string handling.
//
// dedupe.ts re-exports everything here, so every call site keeps importing from
// one place.
//
// See dedupe.ts for the rationale behind the four outcomes.

export type DedupOutcome =
    | "valid"
    | "reactivate"
    | "address_mismatch"
    | "duplicate_skip";

export type ExistingLead = {
    id: string;
    phone: string;
    lead_status: string | null;
    city: string | null;
    state: string | null;
};

export type DedupClassification = {
    outcome: DedupOutcome;
    duplicateLeadId: string | null;
};

/**
 * Canonical Indian-mobile normalisation → `+91XXXXXXXXXX`.
 *
 * Returns null for anything that is not a valid 10-digit Indian mobile. That
 * strictness is the point: a landline, a 9-digit typo or a `5`-prefixed junk
 * row must fail loudly at validation rather than be stored in a shape that can
 * never dedupe against anything again.
 *
 * Accepted: `9876543210`, `+91 98765 43210`, `919876543210`, `09876543210`.
 * Rejected: anything whose first digit isn't 6-9 after stripping.
 */
export function normalizePhone(raw: string): string | null {
    const digits = (raw ?? "").replace(/\D/g, "");
    let ten: string | null = null;
    if (digits.length === 10) ten = digits;
    else if (digits.length === 12 && digits.startsWith("91")) ten = digits.slice(2);
    else if (digits.length === 11 && digits.startsWith("0")) ten = digits.slice(1);
    if (!ten || !/^[6-9]\d{9}$/.test(ten)) return null;
    return `+91${ten}`;
}

/**
 * Classify one normalised phone against whatever already exists for it.
 *
 * `city` may be empty; an incoming lead with no city can't contradict an
 * existing one, so it degrades to duplicate_skip rather than raising a merge
 * request a human has no information to resolve.
 */
export function classifyAgainstExisting(
    city: string,
    existing?: ExistingLead,
): DedupClassification {
    if (!existing) return { outcome: "valid", duplicateLeadId: null };

    const incomingCity = (city ?? "").trim().toLowerCase();
    const existingCity = (existing.city ?? "").trim().toLowerCase();

    // Lost leads are revived, never duplicated (BRD §0.9). Checked before the
    // city comparison: a dealer who moved AND was previously lost is still a
    // reactivation — the new address rides along on the revive.
    if (existing.lead_status === "Lost") {
        return { outcome: "reactivate", duplicateLeadId: existing.id };
    }

    if (existingCity && incomingCity && existingCity !== incomingCity) {
        return { outcome: "address_mismatch", duplicateLeadId: existing.id };
    }

    return { outcome: "duplicate_skip", duplicateLeadId: existing.id };
}
