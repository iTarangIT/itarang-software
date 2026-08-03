/**
 * E-226 — reading and revising the OEM reference price book.
 *
 * The database half of [[oemPricing]], kept separate so the decision rules stay
 * testable without a connection.
 *
 * The table is append-only. A revision closes the live row and inserts a new
 * one; `oem_price` is never updated in place, so "what was this product's
 * reference price in June" is always answerable. Exactly one row per product
 * has `effective_to IS NULL`, enforced in SQL by
 * `oem_reference_prices_live_uniq`.
 */

import { and, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { oemReferencePrices } from "@/lib/db/schema";
import type { CommercialsProductLine } from "@/lib/inside-sales/types";
import { refKey, type OemPriceRef } from "./oemPricing";

// A live transaction handle, taken from db.transaction's callback signature so
// the quote write path can read prices inside the transaction that writes the
// quote. Same idiom as writeTouchpoint's `opts.tx`.
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const OEM_ASSET_TYPES = ["battery", "charger", "paraphernalia"] as const;
export type OemAssetType = (typeof OEM_ASSET_TYPES)[number];

/** Which product-master table an asset_type names, and its identity columns. */
const MASTER_TABLES: Record<
    OemAssetType,
    { table: string; modelIdCol: string; nameCol: string }
> = {
    battery: {
        table: "product_master_batteries",
        modelIdCol: "model_id",
        nameCol: "model_name",
    },
    charger: {
        table: "product_master_chargers",
        modelIdCol: "model_id",
        nameCol: "model_name",
    },
    paraphernalia: {
        table: "product_master_paraphernalia",
        modelIdCol: "item_type_code",
        nameCol: "display_label",
    },
};

export function isOemAssetType(v: string): v is OemAssetType {
    return (OEM_ASSET_TYPES as readonly string[]).includes(v);
}

export interface OemPriceRow {
    price_id: string;
    asset_type: string;
    product_id: string;
    model_id: string | null;
    product_name: string | null;
    oem_price: number;
    effective_from: string;
    effective_to: string | null;
    note: string | null;
    created_by: string | null;
    created_by_name: string | null;
    created_at: string;
}

/**
 * The live reference price for every product on these lines, keyed
 * `asset_type:product_id`.
 *
 * One query regardless of line count. Products with no price simply do not
 * appear in the map, which the rule reads as `no_reference` — that absence is
 * meaningful, so this must not invent a zero.
 */
export async function loadLiveOemPrices(
    lines: CommercialsProductLine[],
    tx?: Tx,
): Promise<Map<string, OemPriceRef>> {
    const productIds = [...new Set(lines.map((l) => l.product_id))];
    if (productIds.length === 0) return new Map();

    const runner = tx ?? db;
    const rows = await runner
        .select({
            price_id: oemReferencePrices.price_id,
            asset_type: oemReferencePrices.asset_type,
            product_id: oemReferencePrices.product_id,
            oem_price: oemReferencePrices.oem_price,
        })
        .from(oemReferencePrices)
        .where(
            and(
                isNull(oemReferencePrices.effective_to),
                inArray(oemReferencePrices.product_id, productIds),
            ),
        );

    const map = new Map<string, OemPriceRef>();
    for (const r of rows) {
        const price = Number(r.oem_price);
        // A NaN price would compare false against everything and silently send
        // a perfectly good quote to the CEO. Treat it as no reference at all.
        if (!Number.isFinite(price)) continue;
        map.set(refKey(r.asset_type, r.product_id), {
            price_id: r.price_id,
            oem_price: price,
        });
    }
    return map;
}

/**
 * Does this product exist, and what is it called?
 *
 * Guards the write path: a price against a product_id that is in no master
 * would sit in the table forever and never match a quote line. Returns null
 * when there is no such product.
 */
export async function lookupMasterProduct(
    assetType: OemAssetType,
    productId: string,
): Promise<{ model_id: string; product_name: string } | null> {
    const t = MASTER_TABLES[assetType];
    const rows = await db.execute<{ model_id: string; product_name: string }>(sql`
        SELECT ${sql.raw(t.modelIdCol)}::text AS model_id,
               ${sql.raw(t.nameCol)}::text   AS product_name
          FROM ${sql.raw(t.table)}
         WHERE id::text = ${productId}
         LIMIT 1
    `);
    const row = (rows as unknown as Record<string, unknown>[])[0];
    if (!row) return null;
    return {
        model_id: String(row.model_id ?? ""),
        product_name: String(row.product_name ?? ""),
    };
}

export interface SetOemPriceInput {
    asset_type: OemAssetType;
    product_id: string;
    model_id: string | null;
    product_name: string | null;
    oem_price: number;
    note: string | null;
    created_by: string;
}

/**
 * Revise a product's reference price.
 *
 * Closes the live row and inserts the new one in one transaction, both stamped
 * with the same instant so the history has no gap and no overlap. Never an
 * UPDATE of `oem_price` — that would erase the number a past quote was judged
 * against, which is the one thing this table exists to keep.
 */
export async function setOemPrice(input: SetOemPriceInput): Promise<string> {
    return db.transaction(async (tx) => {
        const now = new Date();

        await tx.execute(sql`
            UPDATE oem_reference_prices
               SET effective_to = ${now}
             WHERE asset_type = ${input.asset_type}
               AND product_id = ${input.product_id}
               AND effective_to IS NULL
        `);

        const inserted = await tx.execute<{ price_id: string }>(sql`
            INSERT INTO oem_reference_prices
                (asset_type, product_id, model_id, product_name, oem_price,
                 effective_from, note, created_by)
            VALUES
                (${input.asset_type}, ${input.product_id}, ${input.model_id},
                 ${input.product_name}, ${String(input.oem_price)}, ${now},
                 ${input.note}, ${input.created_by})
            RETURNING price_id::text AS price_id
        `);

        const row = (inserted as unknown as Record<string, unknown>[])[0];
        return String(row?.price_id ?? "");
    });
}

/** Every revision for one product, newest first. The audit surface. */
export async function listOemPriceHistory(
    assetType: OemAssetType,
    productId: string,
): Promise<OemPriceRow[]> {
    // created_by is text and users.id is uuid — cast the uuid, never the text,
    // so a non-uuid created_by cannot raise invalid_text_representation and
    // take the whole drawer down. Same guard as the CEO quotation queue.
    const rows = await db.execute<Record<string, unknown>>(sql`
        SELECT p.price_id::text AS price_id, p.asset_type, p.product_id,
               p.model_id, p.product_name, p.oem_price::text AS oem_price,
               p.effective_from, p.effective_to, p.note,
               p.created_by, u.name AS created_by_name, p.created_at
          FROM oem_reference_prices p
          LEFT JOIN users u ON u.id::text = p.created_by
         WHERE p.asset_type = ${assetType}
           AND p.product_id = ${productId}
         ORDER BY p.effective_from DESC, p.created_at DESC
    `);
    return (rows as unknown as Record<string, unknown>[]).map(toPriceRow);
}

function toPriceRow(r: Record<string, unknown>): OemPriceRow {
    return {
        price_id: String(r.price_id),
        asset_type: String(r.asset_type),
        product_id: String(r.product_id),
        model_id: r.model_id != null ? String(r.model_id) : null,
        product_name: r.product_name != null ? String(r.product_name) : null,
        oem_price: Number(r.oem_price),
        effective_from: new Date(r.effective_from as string).toISOString(),
        effective_to: r.effective_to
            ? new Date(r.effective_to as string).toISOString()
            : null,
        note: r.note != null ? String(r.note) : null,
        created_by: r.created_by != null ? String(r.created_by) : null,
        created_by_name: r.created_by_name != null ? String(r.created_by_name) : null,
        created_at: new Date(r.created_at as string).toISOString(),
    };
}

export interface OemCatalogueRow {
    asset_type: OemAssetType;
    product_id: string;
    model_id: string;
    product_name: string;
    detail: string | null;
    oem_price: number | null;
    price_id: string | null;
    effective_from: string | null;
    set_by_name: string | null;
    note: string | null;
}

/**
 * Every active product across the three masters, with its live reference price
 * where one has been set.
 *
 * A LEFT JOIN, not an inner one: the products with NO price are the ones
 * blocking auto-approval, so they are the most important rows on the screen.
 */
export async function listOemCatalogue(): Promise<OemCatalogueRow[]> {
    const rows = await db.execute<Record<string, unknown>>(sql`
        WITH live AS (
            SELECT asset_type, product_id, price_id, oem_price, effective_from,
                   note, created_by
              FROM oem_reference_prices
             WHERE effective_to IS NULL
        ),
        catalogue AS (
            SELECT 'battery'::text AS asset_type, b.id::text AS product_id,
                   b.model_id AS model_id, b.model_name AS product_name,
                   NULLIF(CONCAT_WS(' · ',
                       NULLIF(b.voltage_v::text, '') || 'V',
                       NULLIF(b.capacity_ah::text, '') || 'Ah',
                       b.battery_chemistry), '') AS detail
              FROM product_master_batteries b
             WHERE b.status = 'active'
            UNION ALL
            SELECT 'charger'::text, c.id::text, c.model_id, c.model_name,
                   c.charging_type
              FROM product_master_chargers c
             WHERE c.status = 'active'
            UNION ALL
            SELECT 'paraphernalia'::text, p.id::text, p.item_type_code,
                   p.display_label, NULL
              FROM product_master_paraphernalia p
             WHERE p.status = 'active'
        )
        SELECT cat.asset_type, cat.product_id, cat.model_id, cat.product_name,
               cat.detail,
               live.price_id::text AS price_id,
               live.oem_price::text AS oem_price,
               live.effective_from,
               live.note,
               u.name AS set_by_name
          FROM catalogue cat
          LEFT JOIN live ON live.asset_type = cat.asset_type
                        AND live.product_id = cat.product_id
          LEFT JOIN users u ON u.id::text = live.created_by
         ORDER BY cat.asset_type ASC, cat.product_name ASC
    `);

    return (rows as unknown as Record<string, unknown>[]).map((r) => ({
        asset_type: String(r.asset_type) as OemAssetType,
        product_id: String(r.product_id),
        model_id: String(r.model_id ?? ""),
        product_name: String(r.product_name ?? ""),
        detail: r.detail != null ? String(r.detail) : null,
        oem_price: r.oem_price != null ? Number(r.oem_price) : null,
        price_id: r.price_id != null ? String(r.price_id) : null,
        effective_from: r.effective_from
            ? new Date(r.effective_from as string).toISOString()
            : null,
        set_by_name: r.set_by_name != null ? String(r.set_by_name) : null,
        note: r.note != null ? String(r.note) : null,
    }));
}
