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
