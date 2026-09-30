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

/** Most numbers one search accepts. */
export const CLAIM_SEARCH_MAX_NUMBERS = 50;

/**
 * "98765 43210, +91 9123456789; 09988776655" → the last 10 digits of each valid
 * Indian mobile, de-duplicated, in the order typed. Invalid entries are
 * returned separately so the screen can say which ones it could not read.
 */
export function parseMobileList(input: string): { mobiles: string[]; invalid: string[] } {
    const mobiles: string[] = [];
    const invalid: string[] = [];
    for (const raw of input.split(/[,;\n]+/)) {
        const t = raw.trim();
        if (!t) continue;
        const digits = t.replace(/\D/g, "");
        let ten: string | null = null;
        if (digits.length === 10) ten = digits;
        else if (digits.length === 12 && digits.startsWith("91")) ten = digits.slice(2);
        else if (digits.length === 11 && digits.startsWith("0")) ten = digits.slice(1);
        if (ten && /^[6-9]\d{9}$/.test(ten)) {
            if (!mobiles.includes(ten)) mobiles.push(ten);
        } else {
            invalid.push(t);
        }
    }
    return { mobiles: mobiles.slice(0, CLAIM_SEARCH_MAX_NUMBERS), invalid };
}

/** Marker written into the claim touchpoint's remarks; the Sales Head list keys on it. */
export const OUTSIDE_TERRITORY_MARKER = "[outside territory]";
