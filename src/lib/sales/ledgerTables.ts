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
