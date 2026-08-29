/**
 * E-226 + E-230 — reading and revising the OEM reference price book.
 *
 * The database half of [[oemPricing]], kept separate so the decision rules stay
 * testable without a connection.
 *
 * The table is append-only AND dated. Each open row (effective_to IS NULL) owns
 * a half-open window [effective_from, valid_until) for one product, and one
 * product's windows never overlap — so a product may hold the price in force
 * plus any number of scheduled successors, and "the price in force at time T"
 * is a lookup rather than a computation. `oem_price` is never updated in place,
 * so "what was this product's reference price in June" is always answerable.
 *
 * The non-overlap is held here, in [[setOemPrice]], by locking the product's
 * open rows FOR UPDATE before writing — see the migration for why it is not a
 * btree_gist EXCLUDE constraint.
 */

import { and, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
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
    valid_until: string | null;
    note: string | null;
    created_by: string | null;
    created_by_name: string | null;
    created_at: string;
}

/**
 * The reference price in force for every product on these lines AT `at`, keyed
 * `asset_type:product_id`.
 *
 * `at` is the requirement's "your lookup happens according to the validity set
 * on that pricing engine" — a price scheduled to start on 1 August must leave a
 * quote raised in July alone, and an expired price must not go on approving
 * quotes just because nothing replaced it. Defaults to now() for callers that
 * genuinely mean "right now" (the price screen); the quote path passes the
 * instant the quote is being written.
 *
 * One query regardless of line count. Products with no price in force simply do
 * not appear in the map, which the rule reads as `no_reference` — that absence
 * is meaningful, so this must not invent a zero.
 */
export async function loadLiveOemPrices(
    lines: CommercialsProductLine[],
    tx?: Tx,
    at: Date = new Date(),
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
                // Half-open [from, until): a window starting exactly at `at` is
                // in force, one ending exactly at `at` is not. Two adjacent
                // lines therefore hand over cleanly with no overlapping instant.
                //
                // lte/gt rather than a raw sql`` fragment: Drizzle serialises
                // raw-template parameters through postgres.js `unsafe()` with no
                // column type, which throws ERR_INVALID_ARG_TYPE on a Date. The
                // operators know the column is timestamptz. Same trap the
                // comment in setOemPrice names.
                lte(oemReferencePrices.effective_from, at),
                or(
                    isNull(oemReferencePrices.valid_until),
                    gt(oemReferencePrices.valid_until, at),
                ),
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
    /**
     * Start of validity, inclusive. In the past or now → this replaces whatever
     * is in force. In the future → it queues behind it.
     */
    effective_from: Date;
    /** Declared expiry, exclusive. null = open-ended. */
    valid_until: Date | null;
    note: string | null;
    created_by: string;
}

/** Raised when a new window would straddle a line already on the schedule. */
export class OemPriceOverlapError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "OemPriceOverlapError";
    }
}

function overlaps(
    aFrom: Date,
    aUntil: Date | null,
    bFrom: Date,
    bUntil: Date | null,
): boolean {
    // Half-open [from, until), null until = +infinity.
    const aEnds = aUntil?.getTime() ?? Infinity;
    const bEnds = bUntil?.getTime() ?? Infinity;
    return aFrom.getTime() < bEnds && bFrom.getTime() < aEnds;
}

function fmtDay(d: Date): string {
    return d.toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
    });
}

/**
 * Add a price line for a product.
 *
 * Two shapes, distinguished only by `effective_from`, because that is how the
 * requirement reads them ("add a second line for the same model ID, starting
 * after the validity date we put above"):
 *
 *   effective_from <= now   a REVISION. Supersedes the line in force by
 *                           stamping its effective_to at THIS line's start, so
 *                           the history is contiguous — no gap, no overlap.
 *   effective_from >  now   a SCHEDULED SUCCESSOR. Nothing is superseded; it
 *                           simply waits its turn.
 *
 * A line that would straddle an already-scheduled one is REFUSED rather than
 * quietly closing it. Silently discarding a schedule somebody set up is the
 * worse failure: they would not find out until a quote was judged against a
 * price they thought they had replaced.
 *
 * Never an UPDATE of `oem_price` — that would erase the number a past quote was
 * judged against, which is the one thing this table exists to keep.
 */
export async function setOemPrice(input: SetOemPriceInput): Promise<string> {
    if (input.valid_until && input.valid_until <= input.effective_from) {
        throw new OemPriceOverlapError(
            "The validity end date must be after the start date.",
        );
    }

    return db.transaction(async (tx) => {
        const now = new Date();

        // Lock this product's open rows for the length of the transaction, so
        // two admins saving at once cannot each pass their own overlap check
        // and then both insert. This is what stands in for the EXCLUDE
        // constraint the migration explains we are not using.
        const openRows = await tx
            .select({
                price_id: oemReferencePrices.price_id,
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
            )
            .for("update");

        for (const row of openRows) {
            const rowFrom = new Date(row.effective_from as unknown as string);
            const rowUntil = row.valid_until
                ? new Date(row.valid_until as unknown as string)
                : null;

            if (!overlaps(input.effective_from, input.valid_until, rowFrom, rowUntil)) {
                continue;
            }

            // Overlaps something that starts LATER than us: that is a queued
            // successor, and closing it would throw away a decision somebody
            // already made. Refuse and say what to do about it.
            if (rowFrom.getTime() > input.effective_from.getTime()) {
                throw new OemPriceOverlapError(
                    `A price is already scheduled to start on ${fmtDay(rowFrom)}. ` +
                        `End this one on or before that date, or remove the scheduled ` +
                        `line first.`,
                );
            }

            // Overlaps the line in force (or one starting at the same instant,
            // which the unique index would refuse anyway). Supersede it AT OUR
            // START, so the two windows meet exactly.
            await tx
                .update(oemReferencePrices)
                .set({ effective_to: input.effective_from })
                .where(eq(oemReferencePrices.price_id, row.price_id));
        }

        // Query builder rather than a raw sql`` template, deliberately: Drizzle
        // runs raw templates through postgres.js `unsafe()`, which serialises
        // parameters with no column type and throws ERR_INVALID_ARG_TYPE on a
        // Date object. The builder knows the column is timestamptz and encodes
        // it correctly, so this whole class of bug cannot reach here.
        const inserted = await tx
            .insert(oemReferencePrices)
            .values({
                asset_type: input.asset_type,
                product_id: input.product_id,
                model_id: input.model_id,
                product_name: input.product_name,
                // numeric columns take a string in Drizzle — passing a JS number
                // would lose precision on the way in.
                oem_price: String(input.oem_price),
                effective_from: input.effective_from,
                valid_until: input.valid_until,
                note: input.note,
                created_by: input.created_by,
                created_at: now,
            })
            .returning({ price_id: oemReferencePrices.price_id });

        return String(inserted[0]?.price_id ?? "");
    });
}

/**
 * Drop a line that has not started yet.
 *
 * Only ever a scheduled successor — a price that has been in force has judged
 * quotes and must stay on the record, which is why this refuses anything whose
 * window has already opened. Deleting rather than closing it: a row that never
 * applied to anything is not history, and leaving it as a zero-length closed
 * window would clutter the schedule with lines that never meant anything.
 */
export async function deleteScheduledOemPrice(
    priceId: string,
): Promise<{ deleted: boolean; reason?: string }> {
    return db.transaction(async (tx) => {
        const rows = await tx
            .select({
                price_id: oemReferencePrices.price_id,
                effective_from: oemReferencePrices.effective_from,
                effective_to: oemReferencePrices.effective_to,
            })
            .from(oemReferencePrices)
            .where(eq(oemReferencePrices.price_id, priceId))
            .for("update");

        const row = rows[0];
        if (!row) return { deleted: false, reason: "That price line no longer exists." };
        if (row.effective_to) {
            return { deleted: false, reason: "That line has already been superseded." };
        }
        if (new Date(row.effective_from as unknown as string) <= new Date()) {
            return {
                deleted: false,
                reason:
                    "That price is already in force — quotes have been judged against " +
                    "it. Revise it instead, which keeps it in the history.",
            };
        }

        await tx
            .delete(oemReferencePrices)
            .where(eq(oemReferencePrices.price_id, priceId));
        return { deleted: true };
    });
}

/**
 * Every line for one product, newest first — history, the one in force, and
 * anything scheduled. The audit surface, and what the schedule panel renders.
 */
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
               p.effective_from, p.effective_to, p.valid_until, p.note,
               p.created_by, u.name AS created_by_name, p.created_at
          FROM oem_reference_prices p
          LEFT JOIN users u ON u.id::text = p.created_by
         WHERE p.asset_type = ${assetType}
           AND p.product_id = ${productId}
         ORDER BY p.effective_from DESC, p.created_at DESC
    `);
    return (rows as unknown as Record<string, unknown>[]).map(toPriceRow);
}

/**
 * E-242 — the COMPLETE price history, across every model rather than one
 * product at a time.
 *
 * listOemPriceHistory above answers "what has this product cost?" and is what
 * the per-product drawer opens. This answers the question the requirement
 * actually asked — "which price was applied to which Model ID, and when was it
 * changed?" — which cannot be assembled by opening products one by one.
 *
 * WHY THE PREVIOUS PRICE IS COMPUTED, NOT STORED
 *   The table is append-only, so the row before this one for the same product
 *   IS the previous price; storing it again would be a second copy of a fact
 *   already on disk, and one that could disagree after a backfill. LAG() over
 *   (asset_type, product_id) ORDER BY effective_from reads it directly.
 *   Ordering by effective_from and not created_at matters: a scheduled
 *   successor is INSERTED before it takes effect, so created_at order would
 *   report the change as having happened on the day somebody typed it.
 *
 * No migration: every column this reads has existed since E-226/E-230.
 */
export interface OemPriceHistoryRow extends OemPriceRow {
    /** The price this line replaced, or null when it is the first for its product. */
    previous_price: number | null;
    /** oem_price - previous_price. Null on a first line — not zero, which would read as "no change". */
    delta: number | null;
    /** Percentage move, rounded to 2dp. Null on a first line or a zero previous price. */
    delta_pct: number | null;
}

export interface ListAllOemPriceHistoryOptions {
    assetType?: OemAssetType | null;
    /** Case-insensitive substring match on model_id or product_name. */
    search?: string | null;
    /** Only lines whose window starts on or after this instant. */
    from?: Date | null;
    /** Only lines whose window starts on or before this instant. */
    to?: Date | null;
    limit?: number;
    offset?: number;
}

export const OEM_HISTORY_MAX_LIMIT = 200;

export async function listAllOemPriceHistory(
    options: ListAllOemPriceHistoryOptions = {},
): Promise<{ rows: OemPriceHistoryRow[]; total: number }> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), OEM_HISTORY_MAX_LIMIT);
    const offset = Math.max(options.offset ?? 0, 0);

    const assetType = options.assetType ?? null;
    const search = options.search?.trim() ? `%${options.search.trim()}%` : null;
    // ISO strings, never Date objects: a raw sql`` template is serialised by
    // postgres.js unsafe() with no column type and throws on a Date.
    const from = options.from ? options.from.toISOString() : null;
    const to = options.to ? options.to.toISOString() : null;

    // The window function must see EVERY row of a product to know what preceded
    // the ones being shown, so LAG runs in an inner query over the unfiltered
    // table and the filters apply outside it. Filtering first would make the
    // first row of any filtered page report "no previous price".
    const rows = await db.execute<Record<string, unknown>>(sql`
        WITH ranked AS (
            SELECT p.price_id::text AS price_id, p.asset_type, p.product_id,
                   p.model_id, p.product_name, p.oem_price::text AS oem_price,
                   p.effective_from, p.effective_to, p.valid_until, p.note,
                   p.created_by, p.created_at,
                   LAG(p.oem_price) OVER (
                       PARTITION BY p.asset_type, p.product_id
                       ORDER BY p.effective_from, p.created_at
                   )::text AS previous_price
              FROM oem_reference_prices p
        )
        SELECT r.*, u.name AS created_by_name
          FROM ranked r
          -- created_by is text and users.id is uuid — cast the uuid, never the
          -- text, so a non-uuid created_by cannot take the whole ledger down.
          LEFT JOIN users u ON u.id::text = r.created_by
         WHERE (${assetType}::text IS NULL OR r.asset_type = ${assetType})
           AND (${search}::text IS NULL
                OR r.model_id ILIKE ${search} OR r.product_name ILIKE ${search})
           AND (${from}::timestamptz IS NULL OR r.effective_from >= ${from}::timestamptz)
           AND (${to}::timestamptz IS NULL OR r.effective_from <= ${to}::timestamptz)
         ORDER BY r.effective_from DESC, r.created_at DESC
         LIMIT ${limit} OFFSET ${offset}
    `);

    const counted = await db.execute<{ n: string }>(sql`
        SELECT COUNT(*)::text AS n
          FROM oem_reference_prices p
         WHERE (${assetType}::text IS NULL OR p.asset_type = ${assetType})
           AND (${search}::text IS NULL
                OR p.model_id ILIKE ${search} OR p.product_name ILIKE ${search})
           AND (${from}::timestamptz IS NULL OR p.effective_from >= ${from}::timestamptz)
           AND (${to}::timestamptz IS NULL OR p.effective_from <= ${to}::timestamptz)
    `);

    const total = Number((counted as unknown as Record<string, unknown>[])[0]?.n ?? 0);

    return {
        rows: (rows as unknown as Record<string, unknown>[]).map((r) => {
            const base = toPriceRow(r);
            const prev = r.previous_price == null ? null : Number(r.previous_price);
            const previous_price = prev != null && Number.isFinite(prev) ? prev : null;
            const delta = previous_price == null ? null : base.oem_price - previous_price;
            return {
                ...base,
                previous_price,
                delta,
                delta_pct:
                    previous_price == null || previous_price === 0 || delta == null
                        ? null
                        : Math.round((delta / previous_price) * 10000) / 100,
            };
        }),
        total,
    };
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
        valid_until: r.valid_until
            ? new Date(r.valid_until as string).toISOString()
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
    /** The price in force right now. null = this product is blocking approval. */
    oem_price: number | null;
    price_id: string | null;
    effective_from: string | null;
    /** Declared expiry of the price in force. null = open-ended. */
    valid_until: string | null;
    set_by_name: string | null;
    note: string | null;
    /** The queued successor, if one has been scheduled. */
    next_price: number | null;
    next_price_id: string | null;
    next_effective_from: string | null;
    next_valid_until: string | null;
}

/**
 * Every active product across the three masters, with the price in force and
 * the next one scheduled behind it.
 *
 * A LEFT JOIN, not an inner one: the products with NO price in force are the
 * ones blocking auto-approval, so they are the most important rows on the
 * screen — including the ones that HAD a price which has since lapsed, which
 * this query reports identically to never-priced because operationally they are
 * the same thing.
 */
export async function listOemCatalogue(): Promise<OemCatalogueRow[]> {
    const rows = await db.execute<Record<string, unknown>>(sql`
        WITH live AS (
            SELECT asset_type, product_id, price_id, oem_price, effective_from,
                   valid_until, note, created_by
              FROM oem_reference_prices
             WHERE effective_to IS NULL
               AND effective_from <= now()
               AND (valid_until IS NULL OR valid_until > now())
        ),
        -- The earliest line that has not started yet. DISTINCT ON rather than a
        -- window function because only the front of the queue is shown; the
        -- rest are in the schedule drawer.
        upcoming AS (
            SELECT DISTINCT ON (asset_type, product_id)
                   asset_type, product_id, price_id, oem_price, effective_from,
                   valid_until
              FROM oem_reference_prices
             WHERE effective_to IS NULL
               AND effective_from > now()
             ORDER BY asset_type, product_id, effective_from ASC
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
               live.valid_until,
               live.note,
               u.name AS set_by_name,
               nxt.price_id::text  AS next_price_id,
               nxt.oem_price::text AS next_price,
               nxt.effective_from  AS next_effective_from,
               nxt.valid_until     AS next_valid_until
          FROM catalogue cat
          LEFT JOIN live ON live.asset_type = cat.asset_type
                        AND live.product_id = cat.product_id
          LEFT JOIN upcoming nxt ON nxt.asset_type = cat.asset_type
                                AND nxt.product_id = cat.product_id
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
        effective_from: isoOrNull(r.effective_from),
        valid_until: isoOrNull(r.valid_until),
        set_by_name: r.set_by_name != null ? String(r.set_by_name) : null,
        note: r.note != null ? String(r.note) : null,
        next_price: r.next_price != null ? Number(r.next_price) : null,
        next_price_id: r.next_price_id != null ? String(r.next_price_id) : null,
        next_effective_from: isoOrNull(r.next_effective_from),
        next_valid_until: isoOrNull(r.next_valid_until),
    }));
}

function isoOrNull(v: unknown): string | null {
    if (!v) return null;
    const d = new Date(v as string);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ─── What the daily sweep asks ───────────────────────────────────────────────

export interface ExpiringOemPrice {
    price_id: string;
    asset_type: string;
    product_id: string;
    model_id: string | null;
    product_name: string | null;
    oem_price: number;
    valid_until: string;
    /** True if a successor is already queued — then this is not a problem. */
    has_successor: boolean;
}

/**
 * Prices in force whose declared window closes within `days`, that nobody has
 * been warned about yet.
 *
 * Excludes any product that already has a successor queued: the whole point of
 * the warning is "this lapses and nothing replaces it", and nagging somebody
 * who has already done the work is how people learn to ignore notifications.
 */
export async function listExpiringOemPrices(days: number): Promise<ExpiringOemPrice[]> {
    const rows = await db.execute<Record<string, unknown>>(sql`
        SELECT p.price_id::text AS price_id, p.asset_type, p.product_id,
               p.model_id, p.product_name, p.oem_price::text AS oem_price,
               p.valid_until,
               EXISTS (
                   SELECT 1 FROM oem_reference_prices s
                    WHERE s.asset_type = p.asset_type
                      AND s.product_id = p.product_id
                      AND s.effective_to IS NULL
                      AND s.effective_from >= p.valid_until
               ) AS has_successor
          FROM oem_reference_prices p
         WHERE p.effective_to IS NULL
           AND p.valid_until IS NOT NULL
           AND p.effective_from <= now()
           AND p.valid_until > now()
           AND p.valid_until <= now() + (${String(days)} || ' days')::interval
           AND p.expiry_notified_at IS NULL
         ORDER BY p.valid_until ASC
    `);

    return (rows as unknown as Record<string, unknown>[]).map((r) => ({
        price_id: String(r.price_id),
        asset_type: String(r.asset_type),
        product_id: String(r.product_id),
        model_id: r.model_id != null ? String(r.model_id) : null,
        product_name: r.product_name != null ? String(r.product_name) : null,
        oem_price: Number(r.oem_price),
        valid_until: new Date(r.valid_until as string).toISOString(),
        has_successor: r.has_successor === true,
    }));
}

/** Remember that these lines have been warned about, so the nag fires once. */
export async function markExpiryNotified(priceIds: string[]): Promise<void> {
    if (priceIds.length === 0) return;
    await db
        .update(oemReferencePrices)
        .set({ expiry_notified_at: new Date() })
        .where(inArray(oemReferencePrices.price_id, priceIds));
}

export interface UnpricedOemProduct {
    asset_type: OemAssetType;
    product_id: string;
    model_id: string;
    product_name: string;
    /** True if it once had a price that has since lapsed, vs. never priced. */
    lapsed: boolean;
}

/**
 * Active products with no reference price in force — the ones whose every quote
 * is still going to the CEO.
 *
 * `lapsed` separates "nobody ever set one" from "this product HAD a price and
 * it ran out". Both block auto-approval identically, but the second is a
 * regression against a decision somebody already made — a product that was
 * auto-approving last week and silently stopped — so the notification says so.
 * It is decided by whether any row for the product has a window that has
 * already opened, which is the only honest test: a queued successor alone means
 * the price is merely not live YET.
 */
export async function listUnpricedOemProducts(): Promise<UnpricedOemProduct[]> {
    const catalogue = await listOemCatalogue();
    const unpriced = catalogue.filter((p) => p.oem_price == null);
    if (unpriced.length === 0) return [];

    const rows = await db.execute<Record<string, unknown>>(sql`
        SELECT DISTINCT asset_type, product_id
          FROM oem_reference_prices
         WHERE effective_from <= now()
           AND product_id IN (${sql.join(
               unpriced.map((p) => sql`${p.product_id}`),
               sql`, `,
           )})
    `);
    const everApplied = new Set(
        (rows as unknown as Record<string, unknown>[]).map(
            (r) => `${String(r.asset_type)}:${String(r.product_id)}`,
        ),
    );

    return unpriced.map((p) => ({
        asset_type: p.asset_type,
        product_id: p.product_id,
        model_id: p.model_id,
        product_name: p.product_name,
        lapsed: everApplied.has(`${p.asset_type}:${p.product_id}`),
    }));
}
