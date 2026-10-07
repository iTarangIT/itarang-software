// Who may see and claim the unowned lead pool (tracker IDs 45 / 46, handover
// P0-2, decided 26 Sep 2026). CLIENT-SAFE: no db import — the queue screens read it.
//
//   Reps (ISR, ASM) never list the unowned pool, see its counts or bulk-claim
//   from it. They search by mobile number — one, or several separated by commas
//   — and see only the leads that match, each with Claim.
//   Claims are allowed in any territory; an ASM's claim outside their own is
//   marked on the claim touchpoint and listed for the Sales Head.
//   Managers (Sales Head, admin, CEO…) keep the territory and unassigned views.

import type { AsmQueueTab } from "@/lib/asm/types";
import type { QueueTab } from "@/lib/inside-sales/types";

/** Roles that claim by number search only. */
export const NUMBER_SEARCH_CLAIM_ROLES = ["asm", "inside_sales_rep"] as const;

export function claimsByNumberOnly(role: string | null | undefined): boolean {
    return (NUMBER_SEARCH_CLAIM_ROLES as readonly string[]).includes((role ?? "").toLowerCase());
}

/** Tabs that list the unowned pool — hidden from, and refused to, number-search roles. */
export const ASM_POOL_TABS: readonly AsmQueueTab[] = ["territory", "unclaimed"];
export const ISR_POOL_TABS: readonly QueueTab[] = ["unassigned"];

export function isPoolTabFor(role: string | null | undefined, tab: string): boolean {
    if (!claimsByNumberOnly(role)) return false;
    return (ASM_POOL_TABS as readonly string[]).includes(tab) || (ISR_POOL_TABS as readonly string[]).includes(tab);
}

/** Most numbers one claim search accepts. */
export const CLAIM_SEARCH_MAX_NUMBERS = 50;
/** ID 46: most numbers the Admin / Sales Head leads-list search accepts. */
export const LIST_SEARCH_MAX_NUMBERS = 200;

export type MobileList = {
    mobiles: string[];
    invalid: string[];
    /** Valid numbers past the cap — not searched, so the screen must say so. */
    overLimit: number;
};

/** One entry → its last 10 digits when it is a valid Indian mobile, else null. */
function toMobile(entry: string): string | null {
    const digits = entry.replace(/\D/g, "");
    let ten: string | null = null;
    if (digits.length === 10) ten = digits;
    else if (digits.length === 12 && digits.startsWith("91")) ten = digits.slice(2);
    else if (digits.length === 11 && digits.startsWith("0")) ten = digits.slice(1);
    return ten && /^[6-9]\d{9}$/.test(ten) ? ten : null;
}

/**
 * An entry that is not one number may be several with no comma between them —
 * a column pasted from Excel arrives space-separated ("9876543210 9123456789")
 * or run together. Returns null when it cannot be read as numbers at all.
 */
function splitRun(entry: string): { mobiles: string[]; invalid: string[] } | null {
    const tokens = entry.split(/\s+/).filter((t) => t && !/^(\+?91|0)$/.test(t));
    if (tokens.length > 1) {
        const mobiles: string[] = [];
        const invalid: string[] = [];
        for (const t of tokens) {
            const m = toMobile(t);
            if (m) mobiles.push(m);
            else invalid.push(t);
        }
        if (mobiles.length > 0) return { mobiles, invalid };
    }
    // "98765 43210 91234 56789" or "98765432109123456789": whole 10-digit runs.
    if (/^[\d\s]+$/.test(entry)) {
        const digits = entry.replace(/\s/g, "");
        if (digits.length > 10 && digits.length % 10 === 0) {
            const runs = digits.match(/\d{10}/g) ?? [];
            if (runs.every((r) => /^[6-9]\d{9}$/.test(r))) return { mobiles: runs, invalid: [] };
        }
    }
    return null;
}

/**
 * "98765 43210, +91 9123456789; 09988776655" → the last 10 digits of each valid
 * Indian mobile, de-duplicated, in the order typed. Numbers may be separated by
 * commas, semicolons, new lines, tabs or spaces. Invalid entries are returned
 * separately so the screen can say which ones it could not read, and
 * `overLimit` counts the valid numbers dropped past `max`.
 */
export function parseMobileList(input: string, max: number = CLAIM_SEARCH_MAX_NUMBERS): MobileList {
    const mobiles: string[] = [];
    const invalid: string[] = [];
    const add = (m: string) => {
        if (!mobiles.includes(m)) mobiles.push(m);
    };
    for (const raw of input.split(/[,;\n\r\t]+/)) {
        const t = raw.trim();
        if (!t) continue;
        const one = toMobile(t);
        if (one) {
            add(one);
            continue;
        }
        const run = splitRun(t);
        if (run) {
            run.mobiles.forEach(add);
            invalid.push(...run.invalid);
        } else {
            invalid.push(t);
        }
    }
    return { mobiles: mobiles.slice(0, max), invalid, overLimit: Math.max(0, mobiles.length - max) };
}

/**
 * ID 46: does a leads-list search box hold mobile numbers rather than a name?
 * True when the text is only digits and number punctuation and at least one
 * entry is a valid mobile — so "9876543210," and "9876543210, 12345" select by
 * number instead of falling through to a text match on the raw string. A
 * partial number ("98765") stays a text search.
 */
export function numberSearchMode(search: string | null | undefined): MobileList | null {
    const s = (search ?? "").trim();
    if (!s || !/^[\d\s,;+()-]+$/.test(s)) return null;
    const parsed = parseMobileList(s, LIST_SEARCH_MAX_NUMBERS);
    return parsed.mobiles.length > 0 ? parsed : null;
}

/** Marker written into the claim touchpoint's remarks; the Sales Head list keys on it. */
export const OUTSIDE_TERRITORY_MARKER = "[outside territory]";
