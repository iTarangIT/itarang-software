/**
 * E-321 (tracker ID 4 / handover P1-14) — the optional, dated LIST PRICE printed
 * on a quotation.
 *
 * Two prices per product, with deliberately different jobs:
 *
 *   OEM price   internal. Never shown to the dealer. Decides CEO approval
 *               (oemPricing.ts — UNCHANGED by this file).
 *   List price  the MRP printed on the quotation as "List price", with the
 *               discount down to the quoted rate. Optional: with none set, the
 *               OEM price prints as list price. Never a gate.
 *
 * Same append-only, windowed shape as oem_reference_prices (oemPrices.ts): each
 * open row (effective_to IS NULL) owns a half-open window [effective_from,
 * valid_until) and one product's open windows never overlap, so at most ONE list
 * price is in force per product at any instant. The non-overlap is held in
 * [[setListPrice]] the same way setOemPrice holds it — the product's open rows
 * are locked FOR UPDATE before writing.
 *
 * THE INVARIANT: a list price is never below the OEM price of any overlapping
 * window. Held from BOTH sides — setListPrice refuses a list line below an
 * overlapping OEM line, and setOemPrice (via [[assertOemNotAboveListPrices]])
 * refuses an OEM line above an overlapping list line. Both writers take the same
 * per-product advisory lock ([[lockProductPrices]]) so a list save and an OEM
 * save on the same product cannot each pass their check against the other's
 * pre-commit state.
 *
 * Every reader probes for the table first (to_regclass), so a database without
 * E-321 behaves exactly as before: no list prices, the OEM price prints.
 *
 * Only TYPE imports from ./oemPrices — oemPrices imports this module at runtime,
 * and a value import back would make the two a cycle.
 */

import { and, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { productListPrices } from "@/lib/db/schema";
import type { CommercialsProductLine } from "@/lib/inside-sales/types";
import { refKey, type OemPriceRef } from "./oemPricing";
import type { OemAssetType } from "./oemPrices";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Runner = Tx | typeof db;

// ─── Pure rules ──────────────────────────────────────────────────────────────

/** A half-open priced window [from, until). until null = open-ended. */
export interface PriceWindow {
    price_id?: string | null;
    price: number;
    from: Date;
    until: Date | null;
}

/** Half-open [from, until) overlap, null until = +infinity. */
export function windowsOverlap(
    aFrom: Date,
    aUntil: Date | null,
    bFrom: Date,
    bUntil: Date | null,
): boolean {
    const aEnds = aUntil?.getTime() ?? Infinity;
    const bEnds = bUntil?.getTime() ?? Infinity;
    return aFrom.getTime() < bEnds && bFrom.getTime() < aEnds;
}

/**
 * The OEM windows a proposed list window would sit BELOW.
 *
 * PURE. A violation is an OEM window that overlaps the list window and carries
 * a higher price. Equality is allowed — "never below", not "always above". An
 * OEM window that does not overlap is irrelevant however high it is, and a
 * stretch of the list window with no OEM line at all is not a violation (there
 * is nothing to be below).
 *
 * The same function answers the OEM side: pass the proposed OEM line as the
 * single OEM window and the open list windows one at a time.
 */
export function listPriceViolations(
    listWindow: PriceWindow,
    oemWindows: PriceWindow[],
): PriceWindow[] {
    return oemWindows.filter(
        (o) =>
            windowsOverlap(listWindow.from, listWindow.until, o.from, o.until) &&
            listWindow.price < o.price,
    );
}

/** The live list price for one product, and the row it came from. */
export interface ListPriceRef {
    price_id: string;
    list_price: number;
}

/**
 * PURE. Stamp each line with the list price that prints on the quote:
 * the live list price, else the live OEM price, else null (no list price —
 * the document prints no discount for that line).
 *
 * Snapshotted at write time so the PDF of a past quote never changes when a
 * list price is revised later.
 */
export function snapshotListPrices(
    lines: CommercialsProductLine[],
    listRefs: Map<string, ListPriceRef>,
    oemRefs: Map<string, OemPriceRef>,
): CommercialsProductLine[] {
    return lines.map((l) => {
        const key = refKey(l.asset_type, l.product_id);
        const list = listRefs.get(key)?.list_price ?? oemRefs.get(key)?.oem_price ?? null;
        return { ...l, list_price: list != null && Number.isFinite(list) ? list : null };
    });
}

// ─── Presence probe ──────────────────────────────────────────────────────────

const PROBE_TTL_MS = 5 * 60_000;
let tablePresent: boolean | null = null;
let probedAt = 0;

/**
 * Is product_list_prices on this database? Cached for five minutes, so
 * applying E-321 to a running box takes effect on its own. A to_regclass probe
 * never raises, so it is safe to run inside a transaction that must not abort.
 */
export async function hasListPriceTable(runner: Runner = db): Promise<boolean> {
    const now = Date.now();
    if (tablePresent !== null && now - probedAt < PROBE_TTL_MS) return tablePresent;
    try {
        const res = (await runner.execute(sql`
            SELECT to_regclass('public.product_list_prices') IS NOT NULL AS ok
        `)) as unknown as Array<{ ok: boolean }>;
        tablePresent = Boolean(res[0]?.ok);
    } catch {
        tablePresent = false;
    }
    probedAt = now;
    return tablePresent;
}

/** Test / script hook: forget the cached answer. */
export function resetListPriceTableProbe(): void {
    tablePresent = null;
    probedAt = 0;
}

/** Raised when E-321 has not been applied and a write is attempted. */
export class ListPriceUnavailableError extends Error {
    constructor() {
        super("List prices are not available on this database yet (migration E-321 is not applied).");
        this.name = "ListPriceUnavailableError";
    }
}

// ─── Locking ─────────────────────────────────────────────────────────────────

/**
 * Serialise every price write for one product — OEM and list alike — for the
 * length of the transaction. The FOR UPDATE row locks each writer takes cover
 * its OWN table; this covers the cross-table never-below-OEM check. A string
 * parameter, never a Date, so the raw template is safe.
 */
export async function lockProductPrices(
    tx: Tx,
    assetType: string,
    productId: string,
): Promise<void> {
    await tx.execute(sql`
        SELECT pg_advisory_xact_lock(hashtext(${`product-price:${assetType}:${productId}`}))
    `);
}

// ─── Reads ───────────────────────────────────────────────────────────────────

/**
 * The list price in force for every product on these lines AT `at`, keyed
 * `asset_type:product_id`. Products with none simply do not appear. Empty map
 * on a database without E-321.
 */
export async function loadLiveListPrices(
    lines: CommercialsProductLine[],
    tx?: Tx,
    at: Date = new Date(),
): Promise<Map<string, ListPriceRef>> {
    const productIds = [...new Set(lines.map((l) => l.product_id))];
    if (productIds.length === 0) return new Map();

    const runner = tx ?? db;
    if (!(await hasListPriceTable(runner))) return new Map();

    // Query builder, not a raw template: the operators know the columns are
    // timestamptz and encode the Date correctly (see oemPrices.ts).
    const rows = await runner
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
                or(
                    isNull(productListPrices.valid_until),
                    gt(productListPrices.valid_until, at),
                ),
            ),
        );

    const map = new Map<string, ListPriceRef>();
    for (const r of rows) {
        const price = Number(r.list_price);
        if (!Number.isFinite(price)) continue;
        map.set(refKey(r.asset_type, r.product_id), {
            price_id: r.price_id,
            list_price: price,
        });
    }
    return map;
}

export interface ListPriceRow {
    price_id: string;
    asset_type: string;
    product_id: string;
    model_id: string | null;
    product_name: string | null;
    list_price: number;
    effective_from: string;
    effective_to: string | null;
    valid_until: string | null;
    note: string | null;
    created_by: string | null;
    created_by_name: string | null;
    created_at: string;
}

function isoOrNull(v: unknown): string | null {
    if (!v) return null;
    const d = new Date(v as string);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Every list-price line for one product, newest first. [] without E-321. */
export async function listListPriceHistory(
    assetType: OemAssetType,
    productId: string,
): Promise<ListPriceRow[]> {
    if (!(await hasListPriceTable())) return [];
    // created_by is text and users.id is uuid — cast the uuid, never the text.
    const rows = await db.execute<Record<string, unknown>>(sql`
        SELECT p.price_id::text AS price_id, p.asset_type, p.product_id,
               p.model_id, p.product_name, p.list_price::text AS list_price,
               p.effective_from, p.effective_to, p.valid_until, p.note,
               p.created_by, u.name AS created_by_name, p.created_at
          FROM product_list_prices p
          LEFT JOIN users u ON u.id::text = p.created_by
         WHERE p.asset_type = ${assetType}
           AND p.product_id = ${productId}
         ORDER BY p.effective_from DESC, p.created_at DESC
    `);
    return (rows as unknown as Record<string, unknown>[]).map((r) => ({
        price_id: String(r.price_id),
        asset_type: String(r.asset_type),
        product_id: String(r.product_id),
        model_id: r.model_id != null ? String(r.model_id) : null,
        product_name: r.product_name != null ? String(r.product_name) : null,
        list_price: Number(r.list_price),
        effective_from: new Date(r.effective_from as string).toISOString(),
        effective_to: isoOrNull(r.effective_to),
        valid_until: isoOrNull(r.valid_until),
        note: r.note != null ? String(r.note) : null,
        created_by: r.created_by != null ? String(r.created_by) : null,
        created_by_name: r.created_by_name != null ? String(r.created_by_name) : null,
        created_at: new Date(r.created_at as string).toISOString(),
    }));
}

export interface ListPriceCatalogueRow {
    asset_type: string;
    product_id: string;
    /** In force right now. null = none set; the OEM price prints. */
    list_price: number | null;
    price_id: string | null;
    effective_from: string | null;
    valid_until: string | null;
    /** The queued successor, if one has been scheduled. */
    next_list_price: number | null;
    next_price_id: string | null;
    next_effective_from: string | null;
}

/**
 * The live and next-scheduled list price for every product that has any.
 * Keyed by product on the client; products with no row print the OEM price.
 */
export async function listLiveListPrices(): Promise<{
    available: boolean;
    rows: ListPriceCatalogueRow[];
}> {
    if (!(await hasListPriceTable())) return { available: false, rows: [] };
    const rows = await db.execute<Record<string, unknown>>(sql`
        WITH live AS (
            SELECT asset_type, product_id, price_id, list_price, effective_from, valid_until
              FROM product_list_prices
             WHERE effective_to IS NULL
               AND effective_from <= now()
               AND (valid_until IS NULL OR valid_until > now())
        ),
        upcoming AS (
            SELECT DISTINCT ON (asset_type, product_id)
                   asset_type, product_id, price_id, list_price, effective_from
              FROM product_list_prices
             WHERE effective_to IS NULL
               AND effective_from > now()
             ORDER BY asset_type, product_id, effective_from ASC
        ),
        keys AS (
            SELECT asset_type, product_id FROM live
            UNION
            SELECT asset_type, product_id FROM upcoming
        )
        SELECT k.asset_type, k.product_id,
               live.price_id::text   AS price_id,
               live.list_price::text AS list_price,
               live.effective_from, live.valid_until,
               nxt.price_id::text    AS next_price_id,
               nxt.list_price::text  AS next_list_price,
               nxt.effective_from    AS next_effective_from
          FROM keys k
          LEFT JOIN live ON live.asset_type = k.asset_type AND live.product_id = k.product_id
          LEFT JOIN upcoming nxt ON nxt.asset_type = k.asset_type AND nxt.product_id = k.product_id
    `);
    return {
        available: true,
        rows: (rows as unknown as Record<string, unknown>[]).map((r) => ({
            asset_type: String(r.asset_type),
            product_id: String(r.product_id),
            list_price: r.list_price != null ? Number(r.list_price) : null,
            price_id: r.price_id != null ? String(r.price_id) : null,
            effective_from: isoOrNull(r.effective_from),
            valid_until: isoOrNull(r.valid_until),
            next_list_price: r.next_list_price != null ? Number(r.next_list_price) : null,
            next_price_id: r.next_price_id != null ? String(r.next_price_id) : null,
            next_effective_from: isoOrNull(r.next_effective_from),
        })),
    };
}

// ─── Writes ──────────────────────────────────────────────────────────────────

/** Raised when a new window would straddle a list line already on the schedule. */
export class ListPriceOverlapError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ListPriceOverlapError";
    }
}

/** Raised when a list price would sit below an overlapping OEM price. HTTP 422. */
export class ListPriceBelowOemError extends Error {
    readonly status = 422;
    constructor(message: string) {
        super(message);
        this.name = "ListPriceBelowOemError";
    }
}

function fmtDay(d: Date): string {
    return d.toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        timeZone: "Asia/Kolkata",
    });
}

function fmtInr(n: number): string {
    return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function toWindow(price: unknown, from: unknown, until: unknown, id?: unknown): PriceWindow {
    return {
        price_id: id != null ? String(id) : null,
        price: Number(price),
        from: new Date(from as string),
        until: until ? new Date(until as string) : null,
    };
}

export interface SetListPriceInput {
    asset_type: OemAssetType;
    product_id: string;
    model_id?: string | null;
    product_name?: string | null;
    list_price: number;
    /** Start of validity, inclusive. Past/now = revision, future = queued. */
    effective_from: Date;
    /** Declared expiry, exclusive. null/omitted = open-ended. */
    valid_until?: Date | null;
    note: string | null;
    actor: { id: string };
}

/**
 * Add a list-price line. Same semantics as setOemPrice: a line starting now (or
 * earlier) supersedes the one in force at THIS line's start; a future line
 * queues; a line that would straddle an already-scheduled successor is refused.
 *
 * Plus the never-below-OEM rule: refused (ListPriceBelowOemError, 422) if the
 * price is below the OEM price of ANY open OEM window overlapping
 * [effective_from, valid_until).
 */
export async function setListPrice(input: SetListPriceInput): Promise<string> {
    const validUntil = input.valid_until ?? null;
    if (validUntil && validUntil <= input.effective_from) {
        throw new ListPriceOverlapError("The validity end date must be after the start date.");
    }
    if (!Number.isFinite(input.list_price) || input.list_price < 0) {
        throw new ListPriceBelowOemError("The list price must be a non-negative number.");
    }
    if (!(await hasListPriceTable())) throw new ListPriceUnavailableError();

    return db.transaction(async (tx) => {
        const now = new Date();
        await lockProductPrices(tx, input.asset_type, input.product_id);

        // The OEM side of the invariant. Open OEM lines only: a superseded line
        // is history, and the window of an open one is exactly the time it
        // will judge quotes. ISO strings — raw template (see oemPrices.ts).
        const oemRows = await tx.execute<Record<string, unknown>>(sql`
            SELECT price_id::text AS price_id, oem_price::text AS oem_price,
                   effective_from, valid_until
              FROM oem_reference_prices
             WHERE asset_type = ${input.asset_type}
               AND product_id = ${input.product_id}
               AND effective_to IS NULL
        `);
        const oemWindows = (oemRows as unknown as Record<string, unknown>[]).map((r) =>
            toWindow(r.oem_price, r.effective_from, r.valid_until, r.price_id),
        );
        const violations = listPriceViolations(
            { price: input.list_price, from: input.effective_from, until: validUntil },
            oemWindows,
        );
        if (violations.length > 0) {
            const worst = violations.reduce((a, b) => (b.price > a.price ? b : a));
            throw new ListPriceBelowOemError(
                `The list price ${fmtInr(input.list_price)} is below the OEM price ` +
                    `${fmtInr(worst.price)} in force from ${fmtDay(worst.from)}` +
                    `${worst.until ? ` until ${fmtDay(worst.until)}` : ""}. ` +
                    `A list price can never be below the OEM price.`,
            );
        }

        const openRows = await tx
            .select({
                price_id: productListPrices.price_id,
                effective_from: productListPrices.effective_from,
                valid_until: productListPrices.valid_until,
            })
            .from(productListPrices)
            .where(
                and(
                    eq(productListPrices.asset_type, input.asset_type),
                    eq(productListPrices.product_id, input.product_id),
                    isNull(productListPrices.effective_to),
                ),
            )
            .for("update");

        for (const row of openRows) {
            const rowFrom = new Date(row.effective_from as unknown as string);
            const rowUntil = row.valid_until ? new Date(row.valid_until as unknown as string) : null;
            if (!windowsOverlap(input.effective_from, validUntil, rowFrom, rowUntil)) continue;

            // A queued successor: closing it would discard somebody's decision.
            if (rowFrom.getTime() > input.effective_from.getTime()) {
                throw new ListPriceOverlapError(
                    `A list price is already scheduled to start on ${fmtDay(rowFrom)}. ` +
                        `End this one on or before that date, or remove the scheduled line first.`,
                );
            }

            // The line in force: supersede it at our start so the windows meet.
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
                model_id: input.model_id ?? null,
                product_name: input.product_name ?? null,
                list_price: String(input.list_price),
                effective_from: input.effective_from,
                valid_until: validUntil,
                note: input.note,
                created_by: input.actor.id,
                created_at: now,
            })
            .returning({ price_id: productListPrices.price_id });

        return String(inserted[0]?.price_id ?? "");
    });
}

/**
 * Drop a list line that has not started yet. Anything that has been in force
 * may have been printed on a quote and stays on the record.
 */
export async function deleteScheduledListPrice(
    priceId: string,
): Promise<{ deleted: boolean; reason?: string }> {
    if (!(await hasListPriceTable())) {
        return { deleted: false, reason: "List prices are not available on this database yet." };
    }
    return db.transaction(async (tx) => {
        const rows = await tx
            .select({
                price_id: productListPrices.price_id,
                effective_from: productListPrices.effective_from,
                effective_to: productListPrices.effective_to,
            })
            .from(productListPrices)
            .where(eq(productListPrices.price_id, priceId))
            .for("update");

        const row = rows[0];
        if (!row) return { deleted: false, reason: "That list price line no longer exists." };
        if (row.effective_to) {
            return { deleted: false, reason: "That line has already been superseded." };
        }
        if (new Date(row.effective_from as unknown as string) <= new Date()) {
            return {
                deleted: false,
                reason:
                    "That list price is already in force and may be on quotes. " +
                    "Add a new line instead, which keeps it in the history.",
            };
        }

        await tx.delete(productListPrices).where(eq(productListPrices.price_id, priceId));
        return { deleted: true };
    });
}

/**
 * The OEM half of the invariant, called from setOemPrice inside its
 * transaction. Returns a human message when the proposed OEM line would sit
 * ABOVE an overlapping open list-price line, else null. No-op (null) on a
 * database without E-321. The caller holds lockProductPrices already.
 */
export async function oemAboveListPriceMessage(
    tx: Tx,
    input: {
        asset_type: string;
        product_id: string;
        oem_price: number;
        effective_from: Date;
        valid_until: Date | null;
    },
): Promise<string | null> {
    if (!(await hasListPriceTable(tx))) return null;
    const rows = await tx.execute<Record<string, unknown>>(sql`
        SELECT price_id::text AS price_id, list_price::text AS list_price,
               effective_from, valid_until
          FROM product_list_prices
         WHERE asset_type = ${input.asset_type}
           AND product_id = ${input.product_id}
           AND effective_to IS NULL
    `);
    const oemWindow: PriceWindow = {
        price: input.oem_price,
        from: input.effective_from,
        until: input.valid_until,
    };
    for (const r of rows as unknown as Record<string, unknown>[]) {
        const list = toWindow(r.list_price, r.effective_from, r.valid_until, r.price_id);
        if (listPriceViolations(list, [oemWindow]).length > 0) {
            return (
                `The OEM price ${fmtInr(input.oem_price)} is above the list price ` +
                `${fmtInr(list.price)} in force from ${fmtDay(list.from)}` +
                `${list.until ? ` until ${fmtDay(list.until)}` : ""}. ` +
                `Raise the list price first — a list price can never be below the OEM price.`
            );
        }
    }
    return null;
}
