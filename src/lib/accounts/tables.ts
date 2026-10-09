/**
 * E-321 presence probe. The account-ownership tables are new; until E-321 is
 * applied to an environment, every reader must fall back to the pre-E-321
 * behaviour (lead-keyed matching) instead of 500ing on "relation does not
 * exist". Same TTL'd to_regclass idiom as revenueSource.ts's sales_invoices
 * probe, so applying the migration to a running box takes effect on its own.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

const PROBE_TTL_MS = 5 * 60_000;
let present: boolean | null = null;
let probedAt = 0;

export async function hasAccountOwnershipTables(): Promise<boolean> {
    const now = Date.now();
    if (present !== null && now - probedAt < PROBE_TTL_MS) return present;
    try {
        const res = (await db.execute(sql`
            SELECT to_regclass('public.account_ownership') IS NOT NULL
               AND to_regclass('public.account_owner_history') IS NOT NULL
               AND to_regclass('public.account_gstins') IS NOT NULL
               AND to_regclass('public.invoice_account_links') IS NOT NULL AS ok
        `)) as unknown as Array<{ ok: boolean }>;
        present = Boolean(res[0]?.ok);
    } catch {
        present = false;
    }
    probedAt = now;
    return present;
}

/** Test / script hook: forget the cached answer. */
export function resetAccountTablesProbe(): void {
    present = null;
    probedAt = 0;
}

let closuresPresent: boolean | null = null;
let closuresProbedAt = 0;

/** E-332 (ID 5) presence probe for account_closures, same TTL idiom as above. */
export async function hasAccountClosuresTable(): Promise<boolean> {
    const now = Date.now();
    if (closuresPresent !== null && now - closuresProbedAt < PROBE_TTL_MS) return closuresPresent;
    try {
        const res = (await db.execute(sql`
            SELECT to_regclass('public.account_closures') IS NOT NULL AS ok
        `)) as unknown as Array<{ ok: boolean }>;
        closuresPresent = Boolean(res[0]?.ok);
    } catch {
        closuresPresent = false;
    }
    closuresProbedAt = now;
    return closuresPresent;
}

let claimsPresent: boolean | null = null;
let claimsProbedAt = 0;

/**
 * E-334 (ID 5) presence probe for account_order_claims + account_reminder_log,
 * same TTL idiom as above. Both need the E-321 accounts too.
 */
export async function hasOrderClaimTables(): Promise<boolean> {
    const now = Date.now();
    if (claimsPresent !== null && now - claimsProbedAt < PROBE_TTL_MS) return claimsPresent;
    try {
        const res = (await db.execute(sql`
            SELECT to_regclass('public.account_order_claims') IS NOT NULL
               AND to_regclass('public.account_reminder_log') IS NOT NULL AS ok
        `)) as unknown as Array<{ ok: boolean }>;
        claimsPresent = Boolean(res[0]?.ok) && (await hasAccountOwnershipTables());
    } catch {
        claimsPresent = false;
    }
    claimsProbedAt = now;
    return claimsPresent;
}
