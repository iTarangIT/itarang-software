/**
 * E-322 (tracker ID 39) — "CRM reads SKUs and number billed per SKU, amount by
 * SKU excl. GST" from invoice lines (Vyapar register + Zoho backfill).
 * Void invoices excluded; a credit note's lines are stored negative (source
 * 'credit', ID 71), so its items come off the month it is issued. A SKU is the mapped CRM
 * product where the Vyapar item name has been mapped, else the item name as
 * billed.
 *
 * A14: the ledger counts EVERY invoice line, matched to a dealer or not;
 * dealer_quantity is the part on invoices matched to a dealer — the Sales
 * dashboard's "Batteries sold" — so the two can be read side by side.
 *
 * HANDOVER-A16: an item not mapped yet is one row per PRODUCT FAMILY
 * (itemFamilyKeySql — the rows of Item mapping), named by one of its
 * spellings, not one row per spelling.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { matchedLinesUnion, REVENUE_NOT_VOID } from "@/lib/dashboard/revenueSource";
import { itemFamilyKeySql } from "@/lib/sales/itemMap";

export interface SkuRow {
    month: string;
    product_class: string;
    sku: string;
    mapped: boolean;
    quantity: number;
    /** Units on invoices matched to a dealer (account or lead) — what Batteries sold counts. */
    dealer_quantity: number;
    amount_excl_gst: number;
    invoices: number;
}

export async function skuReport(from: string, to: string): Promise<{ available: boolean; rows: SkuRow[] }> {
    const lines = await matchedLinesUnion();
    if (!lines) return { available: false, rows: [] };
    const res = (await db.execute(sql`
        SELECT to_char(r.invoice_date, 'YYYY-MM')                                   AS month,
               r.product_class,
               COALESCE(MIN(pb.model_name), MIN(pc.model_name), MIN(pp.display_label), MIN(r.item_name), '(no item name)') AS sku,
               (r.product_id IS NOT NULL)                                           AS mapped,
               COALESCE(SUM(r.quantity), 0)::float8                                 AS quantity,
               COALESCE(SUM(r.quantity) FILTER (WHERE r.account_id IS NOT NULL OR r.dealer_lead_id IS NOT NULL), 0)::float8
                                                                                    AS dealer_quantity,
               COALESCE(SUM(r.amount_excl_gst), 0)::float8                          AS amount_excl_gst,
               COUNT(DISTINCT r.source || ':' || r.id)::int                         AS invoices
          FROM (SELECT l.*, ${itemFamilyKeySql(sql`l.item_name`)} AS item_family FROM ${lines} AS l) AS r
          LEFT JOIN product_master_batteries pb     ON r.asset_type = 'battery'       AND pb.id::text = r.product_id
          LEFT JOIN product_master_chargers pc      ON r.asset_type = 'charger'       AND pc.id::text = r.product_id
          LEFT JOIN product_master_paraphernalia pp ON r.asset_type = 'paraphernalia' AND pp.id::text = r.product_id
         WHERE ${REVENUE_NOT_VOID}
           AND r.invoice_date >= ${from}::date
           AND r.invoice_date <= ${to}::date
         -- The product when mapped, else the item's family (else its spelling).
         GROUP BY 1, 2, COALESCE(pb.model_name, pc.model_name, pp.display_label, r.item_family, r.item_name), 4
         ORDER BY 1 DESC, 2, 5 DESC
    `)) as unknown as SkuRow[];
    return {
        available: true,
        rows: res.map((r) => ({
            ...r,
            quantity: Number(r.quantity),
            amount_excl_gst: Number(r.amount_excl_gst),
            invoices: Number(r.invoices),
        })),
    };
}
