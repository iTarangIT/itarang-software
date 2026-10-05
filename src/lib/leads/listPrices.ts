/**
 * E-323 — reading and revising the product LIST price book (IDs 4 and 47).
 *
 * The database half of [[listPricing]]. Same dated, append-only shape as the
 * OEM price book in ./oemPrices.ts, on its own table: each open row
 * (effective_to IS NULL) owns a half-open window [effective_from, valid_until)
 * for one product; a start date now or earlier is a revision and closes the
 * row in force, a future one is a scheduled successor.
 *
 * One extra rule: a list price is never below the OEM price in ANY date it
 * covers, scheduled OEM changes included. Checked here when a list price is
 * saved, and in setOemPrice when an OEM price is raised.
 */

import { and, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { oemReferencePrices, productListPrices } from "@/lib/db/schema";
import type { CommercialsProductLine } from "@/lib/inside-sales/types";
import { firstOemAboveList, type ListPriceSnapshot, windowsOverlap } from "./listPricing";
import { listOemCatalogue, type OemAssetType, type OemCatalogueRow } from "./oemPrices";
import { refKey } from "./oemPricing";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Raised when a list price cannot be saved; the route answers 409 with the message. */
export class ListPriceError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ListPriceError";
    }
}

const fmtDay = (d: Date) => d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;
const asDate = (v: unknown) => new Date(v as string);

export interface ListPriceRef {
    price_id: string;
    list_price: number;
}

/** The list price in force for every product on these lines AT `at`, keyed `asset_type:product_id`. */
export async function loadLiveListPrices(
    lines: CommercialsProductLine[],
    tx?: Tx,
    at: Date = new Date(),
): Promise<Map<string, ListPriceRef>> {
    const productIds = [...new Set(lines.map((l) => l.product_id))];
    if (productIds.length === 0) return new Map();

    const rows = await (tx ?? db)
        .select({
            price_id: productListPrices.price_id,
            asset_type: productListPrices.asset_type,
            product_id: productListPrices.product_id,
            list_price: productListPrices.list_price,
        })
        .from(productListPrices)
        .where(
            and(
                isNull(productListPrices.effective_to),
                inArray(productListPrices.product_id, productIds),
                lte(productListPrices.effective_from, at),
                or(isNull(productListPrices.valid_until), gt(productListPrices.valid_until, at)),
            ),
        );

    const map = new Map<string, ListPriceRef>();
    for (const r of rows) {
        const price = Number(r.list_price);
        if (!Number.isFinite(price)) continue;
        map.set(refKey(r.asset_type, r.product_id), { price_id: r.price_id, list_price: price });
    }
    return map;
}

/** What createCommercial freezes on the quote: one entry per line, null where no list price is set. */
export async function snapshotListPrices(
    lines: CommercialsProductLine[],
    tx: Tx,
    at: Date,
): Promise<ListPriceSnapshot> {
    const live = await loadLiveListPrices(lines, tx, at);
    return {
        lines: lines.map((l) => {
            const ref = live.get(refKey(l.asset_type, l.product_id));
            return {
                asset_type: l.asset_type,
                product_id: l.product_id,
                list_price: ref?.list_price ?? null,
                list_price_id: ref?.price_id ?? null,
            };
        }),
    };
}

export interface SetListPriceInput {
    asset_type: OemAssetType;
    product_id: string;
    model_id: string | null;
    product_name: string | null;
    list_price: number;
    effective_from: Date;
    valid_until: Date | null;
    note: string | null;
    created_by: string;
}

export async function setListPrice(input: SetListPriceInput): Promise<string> {
    if (input.valid_until && input.valid_until <= input.effective_from) {
        throw new ListPriceError("The validity end date must be after the start date.");
    }

    return db.transaction(async (tx) => {
        const product = and(
            eq(productListPrices.asset_type, input.asset_type),
            eq(productListPrices.product_id, input.product_id),
            isNull(productListPrices.effective_to),
        );
        const openRows = await tx
            .select({
                price_id: productListPrices.price_id,
                effective_from: productListPrices.effective_from,
                valid_until: productListPrices.valid_until,
            })
            .from(productListPrices)
            .where(product)
            .for("update");

        // List >= OEM for every date this window covers, scheduled OEM lines included.
        const oemRows = await tx
            .select({
                oem_price: oemReferencePrices.oem_price,
                effective_from: oemReferencePrices.effective_from,
                valid_until: oemReferencePrices.valid_until,
            })
            .from(oemReferencePrices)
            .where(
                and(
                    eq(oemReferencePrices.asset_type, input.asset_type),
                    eq(oemReferencePrices.product_id, input.product_id),
                    isNull(oemReferencePrices.effective_to),
                ),
            );
        const above = firstOemAboveList(
            { from: input.effective_from, until: input.valid_until, price: input.list_price },
            oemRows.map((o) => ({
                from: asDate(o.effective_from),
                until: o.valid_until ? asDate(o.valid_until) : null,
                price: Number(o.oem_price),
            })),
        );
        if (above) {
            throw new ListPriceError(
                `The list price ${inr(input.list_price)} is below the OEM price ${inr(above.price)} ` +
                    `in force from ${fmtDay(above.from)}. A list price can never be below the OEM price.`,
            );
        }

        for (const row of openRows) {
            const rowFrom = asDate(row.effective_from);
            const rowUntil = row.valid_until ? asDate(row.valid_until) : null;
            if (!windowsOverlap({ from: input.effective_from, until: input.valid_until }, { from: rowFrom, until: rowUntil })) {
                continue;
            }
            if (rowFrom.getTime() > input.effective_from.getTime()) {
                throw new ListPriceError(
                    `A list price is already scheduled to start on ${fmtDay(rowFrom)}. ` +
                        `End this one on or before that date, or remove the scheduled line first.`,
                );
            }
            await tx
                .update(productListPrices)
                .set({ effective_to: input.effective_from })
                .where(eq(productListPrices.price_id, row.price_id));
        }

        const inserted = await tx
            .insert(productListPrices)
            .values({
                asset_type: input.asset_type,
                product_id: input.product_id,
                model_id: input.model_id,
                product_name: input.product_name,
                list_price: String(input.list_price),
                effective_from: input.effective_from,
                valid_until: input.valid_until,
                note: input.note,
                created_by: input.created_by,
            })
            .returning({ price_id: productListPrices.price_id });
        return String(inserted[0]?.price_id ?? "");
    });
}

/** Drop a list price that has not started yet. One that has been in force stays on the record. */
export async function deleteScheduledListPrice(priceId: string): Promise<{ deleted: boolean; reason?: string }> {
    return db.transaction(async (tx) => {
        const [row] = await tx
            .select({
                price_id: productListPrices.price_id,
                effective_from: productListPrices.effective_from,
                effective_to: productListPrices.effective_to,
            })
            .from(productListPrices)
            .where(eq(productListPrices.price_id, priceId))
            .for("update");
        if (!row) return { deleted: false, reason: "That list price no longer exists." };
        if (row.effective_to || asDate(row.effective_from).getTime() <= Date.now()) {
            return { deleted: false, reason: "Only a list price that has not started yet can be removed." };
        }
        await tx.delete(productListPrices).where(eq(productListPrices.price_id, priceId));
        return { deleted: true };
    });
}

export interface ListPriceHistoryRow {
    price_id: string;
    list_price: number;
    effective_from: string;
    /** Set when a later line replaced this one. */
    effective_to: string | null;
    valid_until: string | null;
    note: string | null;
    created_by_name: string | null;
    created_at: string;
    status: "in_force" | "scheduled" | "superseded" | "expired";
}

/**
 * Every list price line for one product, newest first — past prices, the one
 * in force and everything scheduled, with who set each and the note.
 */
export async function listListPriceHistory(assetType: OemAssetType, productId: string): Promise<ListPriceHistoryRow[]> {
    // created_by is text and users.id is uuid — cast the uuid, never the text.
    const rows = (await db.execute(sql`
        SELECT p.price_id::text AS price_id, p.list_price::text AS list_price,
               p.effective_from, p.effective_to, p.valid_until, p.note,
               u.name AS created_by_name, p.created_at
          FROM product_list_prices p
          LEFT JOIN users u ON u.id::text = p.created_by
         WHERE p.asset_type = ${assetType}
           AND p.product_id = ${productId}
         ORDER BY p.effective_from DESC, p.created_at DESC
    `)) as unknown as Record<string, unknown>[];
    const now = Date.now();
    const iso = (v: unknown) => (v ? asDate(v).toISOString() : null);
    return rows.map((r) => {
        const from = asDate(r.effective_from).getTime();
        const until = r.valid_until ? asDate(r.valid_until).getTime() : null;
        const status: ListPriceHistoryRow["status"] = r.effective_to
            ? "superseded"
            : from > now
              ? "scheduled"
              : until != null && until <= now
                ? "expired"
                : "in_force";
        return {
            price_id: String(r.price_id),
            list_price: Number(r.list_price),
            effective_from: iso(r.effective_from)!,
            effective_to: iso(r.effective_to),
            valid_until: iso(r.valid_until),
            note: (r.note as string | null) ?? null,
            created_by_name: (r.created_by_name as string | null) ?? null,
            created_at: iso(r.created_at)!,
            status,
        };
    });
}

export interface ListPriceCatalogueRow {
    asset_type: OemAssetType;
    product_id: string;
    model_id: string;
    product_name: string;
    detail: string | null;
    /** Shown so the person setting a list price can see the floor. */
    oem_price: number | null;
    list_price: number | null;
    list_price_id: string | null;
    effective_from: string | null;
    valid_until: string | null;
    next_list_price: number | null;
    next_list_price_id: string | null;
    next_effective_from: string | null;
}

/** Every active product with its OEM price, the list price in force and the next one scheduled. */
export async function listListPriceCatalogue(): Promise<ListPriceCatalogueRow[]> {
    const [products, open] = await Promise.all([
        listOemCatalogue() as Promise<OemCatalogueRow[]>,
        db
            .select({
                price_id: productListPrices.price_id,
                asset_type: productListPrices.asset_type,
                product_id: productListPrices.product_id,
                list_price: productListPrices.list_price,
                effective_from: productListPrices.effective_from,
                valid_until: productListPrices.valid_until,
            })
            .from(productListPrices)
            .where(isNull(productListPrices.effective_to)),
    ]);
    const now = Date.now();
    const byProduct = new Map<string, typeof open>();
    for (const r of open) {
        const k = refKey(r.asset_type, r.product_id);
        byProduct.set(k, [...(byProduct.get(k) ?? []), r]);
    }
    const iso = (v: unknown) => (v ? asDate(v).toISOString() : null);

    return products.map((p) => {
        const rows = (byProduct.get(refKey(p.asset_type, p.product_id)) ?? []).sort(
            (a, b) => asDate(a.effective_from).getTime() - asDate(b.effective_from).getTime(),
        );
        const live = rows.find(
            (r) => asDate(r.effective_from).getTime() <= now && (!r.valid_until || asDate(r.valid_until).getTime() > now),
        );
        const next = rows.find((r) => asDate(r.effective_from).getTime() > now);
        return {
            asset_type: p.asset_type,
            product_id: p.product_id,
            model_id: p.model_id,
            product_name: p.product_name,
            detail: p.detail,
            oem_price: p.oem_price,
            list_price: live ? Number(live.list_price) : null,
            list_price_id: live?.price_id ?? null,
            effective_from: iso(live?.effective_from),
            valid_until: iso(live?.valid_until),
            next_list_price: next ? Number(next.list_price) : null,
            next_list_price_id: next?.price_id ?? null,
            next_effective_from: iso(next?.effective_from),
        };
    });
}
