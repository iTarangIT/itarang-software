/**
 * E-322 (tracker ID 39) — "CRM reads SKUs and number billed per SKU, amount by
 * SKU excl. GST" from invoice lines (Vyapar register + Zoho backfill).
 * Void invoices excluded; credit notes carry no lines. A SKU is the mapped CRM
 * product where the Vyapar item name has been mapped, else the item name as
 * billed.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { matchedLinesUnion, REVENUE_NOT_VOID } from "@/lib/dashboard/revenueSource";

export interface SkuRow {
    month: string;
    product_class: string;
    sku: string;
    mapped: boolean;
    quantity: number;
    amount_excl_gst: number;
    invoices: number;
}

export async function skuReport(from: string, to: string): Promise<{ available: boolean; rows: SkuRow[] }> {
    const lines = await matchedLinesUnion();
    if (!lines) return { available: false, rows: [] };
    const res = (await db.execute(sql`
        SELECT to_char(r.invoice_date, 'YYYY-MM')                                   AS month,
               r.product_class,
               COALESCE(pb.model_name, pc.model_name, pp.display_label, r.item_name, '(no item name)') AS sku,
               (r.product_id IS NOT NULL)                                           AS mapped,
               COALESCE(SUM(r.quantity), 0)::float8                                 AS quantity,
               COALESCE(SUM(r.amount_excl_gst), 0)::float8                          AS amount_excl_gst,
               COUNT(DISTINCT r.source || ':' || r.id)::int                         AS invoices
          FROM ${lines} AS r
          LEFT JOIN product_master_batteries pb     ON r.asset_type = 'battery'       AND pb.id::text = r.product_id
          LEFT JOIN product_master_chargers pc      ON r.asset_type = 'charger'       AND pc.id::text = r.product_id
          LEFT JOIN product_master_paraphernalia pp ON r.asset_type = 'paraphernalia' AND pp.id::text = r.product_id
         WHERE ${REVENUE_NOT_VOID}
           AND r.invoice_date >= ${from}::date
           AND r.invoice_date <= ${to}::date
         GROUP BY 1, 2, 3, 4
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
