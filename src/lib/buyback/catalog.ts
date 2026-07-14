/**
 * The battery catalog (M16).
 *
 *   AC: "catalog edits never change open requests' reference price."
 *
 * THAT ALREADY HOLDS, and it is worth being precise about why, because it looks
 * fragile and isn't:
 *
 *   · buyback_lines.expected_price_per_unit is COPIED onto the line when the line
 *     is created. Every screen and every document reads the line's own price, not
 *     the catalog's current one.
 *   · buyback_lines.price_book_version_at_create records WHICH catalog version
 *     that copy came from.
 *
 * So a price edit today cannot move a request raised last week — the request is
 * not looking at the catalog. What was missing before E-188 is the HISTORY: the
 * snapshot tells you the request used version 2, but nothing could tell you what
 * version 2 actually said. An auditor asking "why does this six-month-old request
 * quote ₹5,200?" had nowhere to look. catalog_price_history is that record.
 *
 * Every price change therefore does two things atomically: bump the variant's
 * price_book_version, and append the new prices to the history at that version.
 */

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { notifyRoles } from "@/lib/notifications/notify";

import { BUYBACK_ADMIN_ROLES } from "./auth";
import type { BuybackTx } from "./tx";

/** The business is meant to look at prices weekly (M16). */
export const PRICE_REVIEW_INTERVAL_DAYS = 7;

export interface VariantRow {
  id: string;
  type: string;
  chemistry: string | null;
  voltage: string;
  ah: string;
  unit_price: string | null;
  est_buyback_price_working: string | null;
  est_buyback_price_dead: string | null;
  price_book_version: number;
  active: boolean;
  /** How many OPEN requests still reference this variant — see `deactivate`. */
  open_lines?: number;
}

export async function listVariants(includeInactive = false): Promise<VariantRow[]> {
  const rows = await db.execute(sql`
    SELECT
      cv.*,
      (
        SELECT count(*)::int
        FROM buyback_lines bl
        JOIN buyback_batches bb ON bb.id = bl.batch_id
        JOIN buyback_requests br ON br.id = bb.request_id
        JOIN buyback_deals bd    ON bd.request_id = br.id
        WHERE bl.variant_id = cv.id
          AND bd.status NOT IN ('CLOSED', 'REJECTED', 'CANCELLED')
      ) AS open_lines
    FROM catalog_variants cv
    ${includeInactive ? sql`` : sql`WHERE cv.active`}
    ORDER BY cv.voltage, cv.ah
  `);
  return rows as unknown as VariantRow[];
}

export interface PriceChange {
  unit_price?: number | null;
  est_buyback_price_working?: number | null;
  est_buyback_price_dead?: number | null;
}

/**
 * Change a variant's prices.
 *
 * Bumps price_book_version and appends to catalog_price_history, in one
 * transaction. Open requests are untouched — they carry their own copy of the
 * price and the version it came from.
 */
export async function repriceVariant(
  tx: BuybackTx,
  variantId: string,
  change: PriceChange,
  actorId: string | null,
  note?: string,
): Promise<{ version: number }> {
  const rows = await tx.execute(sql`
    UPDATE catalog_variants
    SET unit_price                = COALESCE(${change.unit_price ?? null}, unit_price),
        est_buyback_price_working = COALESCE(${change.est_buyback_price_working ?? null}, est_buyback_price_working),
        est_buyback_price_dead    = COALESCE(${change.est_buyback_price_dead ?? null}, est_buyback_price_dead),
        price_book_version        = price_book_version + 1,
        updated_at                = now()
    WHERE id = ${variantId}
    RETURNING price_book_version, unit_price, est_buyback_price_working, est_buyback_price_dead
  `);

  const row = (rows as unknown as Array<Record<string, unknown>>)[0];
  if (!row) throw new Error("Variant not found.");

  const version = Number(row.price_book_version);

  // The record that makes "what was the price at version 3?" answerable.
  await tx.execute(sql`
    INSERT INTO catalog_price_history
      (variant_id, price_book_version, unit_price, est_buyback_price_working,
       est_buyback_price_dead, changed_by, note)
    VALUES (${variantId}, ${version}, ${row.unit_price as string},
            ${row.est_buyback_price_working as string}, ${row.est_buyback_price_dead as string},
            ${actorId}, ${note ?? null})
  `);

  return { version };
}

/** The price history of one variant, newest first. */
export async function priceHistory(variantId: string) {
  const rows = await db.execute(sql`
    SELECT ph.*, u.name AS changed_by_name
    FROM catalog_price_history ph
    LEFT JOIN users u ON u.id = ph.changed_by
    WHERE ph.variant_id = ${variantId}
    ORDER BY ph.price_book_version DESC
  `);
  return rows as unknown as Array<Record<string, unknown>>;
}

/**
 * Days since the last recorded price review, or null if there has never been one.
 */
export async function daysSinceReview(): Promise<number | null> {
  const rows = await db.execute(sql`
    SELECT EXTRACT(EPOCH FROM (now() - MAX(created_at))) / 86400 AS days
    FROM catalog_price_reviews
  `);
  const days = (rows as unknown as Array<{ days: string | null }>)[0]?.days;
  return days === null || days === undefined ? null : Math.floor(Number(days));
}

export async function recordReview(actorId: string | null, note?: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO catalog_price_reviews (reviewed_by, note) VALUES (${actorId}, ${note ?? null})
  `);
}

/**
 * The weekly nudge (M16). Called by the daily ticker.
 *
 * Scrap prices move. A catalog nobody has looked at in a month is quietly
 * mispricing every new request — which is not a crash, and so it is exactly the
 * sort of thing that goes unnoticed for a quarter.
 */
export async function checkPriceReviewDue(): Promise<{ due: boolean; days: number | null }> {
  const days = await daysSinceReview();
  const due = days === null || days >= PRICE_REVIEW_INTERVAL_DAYS;

  if (!due) return { due, days };

  await notifyRoles([...BUYBACK_ADMIN_ROLES], {
    type: "buyback.price_review_due",
    title: "Battery buyback prices need a review",
    message:
      days === null
        ? "The buyback catalog has never been reviewed. Scrap prices move — every new request is being quoted against prices nobody has checked."
        : `The buyback catalog was last reviewed ${days} days ago. Scrap prices move; new requests are being quoted against stale numbers.`,
    data: { days_since_review: days },
  }).catch(() => {
    // Best-effort by notifyRoles' own contract.
  });

  return { due, days };
}
