/**
 * E-322 presence probe (tracker IDs 39, 70, 71): invoice lines, the Zoho
 * GSTIN backfill, voids and credit notes. Revenue readers fall back to the
 * pre-E-322 union when it is absent instead of failing on "relation does not
 * exist". TTL'd so applying the migration to a running box takes effect alone.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

const PROBE_TTL_MS = 5 * 60_000;
let present: boolean | null = null;
let probedAt = 0;

export async function hasInvoiceLedgerTables(): Promise<boolean> {
    const now = Date.now();
    if (present !== null && now - probedAt < PROBE_TTL_MS) return present;
    try {
        const res = (await db.execute(sql`
            SELECT to_regclass('public.invoice_line_items') IS NOT NULL
               AND to_regclass('public.zoho_customer_gstins') IS NOT NULL
               AND to_regclass('public.invoice_voids') IS NOT NULL
               AND to_regclass('public.credit_notes') IS NOT NULL AS ok
        `)) as unknown as Array<{ ok: boolean }>;
        present = Boolean(res[0]?.ok);
    } catch {
        present = false;
    }
    probedAt = now;
    return present;
}

let refusedCols: boolean | null = null;
let refusedAt = 0;

/**
 * E-340 (ID 62): zoho_customer_gstins.refused_gstin / refused_reason — a Zoho
 * customer GSTIN that failed the check, shown in Needs attention.
 */
export async function hasZohoRefusedGstin(): Promise<boolean> {
    const now = Date.now();
    if (refusedCols !== null && now - refusedAt < PROBE_TTL_MS) return refusedCols;
    try {
        const res = (await db.execute(sql`
            SELECT COUNT(*) = 2 AS ok FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'zoho_customer_gstins'
               AND column_name IN ('refused_gstin', 'refused_reason')
        `)) as unknown as Array<{ ok: boolean }>;
        refusedCols = Boolean(res[0]?.ok);
    } catch {
        refusedCols = false;
    }
    refusedAt = now;
    return refusedCols;
}
