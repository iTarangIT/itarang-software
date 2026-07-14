/**
 * Pickup, variance, and BWM 2022 compliance (M05).
 *
 * THE GATE THIS FILE EXISTS FOR:
 *
 *   AC: "dealer WhatsApp ack on variance BEFORE payout."
 *
 * A variance means we counted fewer batteries — or fewer WORKING ones — than the
 * dealer said they were handing over. That changes what we owe them. Paying out
 * first and arguing afterwards means arguing about money that has already left
 * the building, which is a conversation nobody wins.
 *
 * So `assertPayoutAllowed()` refuses a dealer settlement while a variance sits
 * unacknowledged, and the settlement route calls it. The dealer is notified on
 * WhatsApp the moment the variance is recorded (that is the "WhatsApp ack" in the
 * AC — they are told, and they must confirm) and their acknowledgement lifts the
 * gate.
 *
 * BWM 2022 (Battery Waste Management Rules) is why the e-way bill number and the
 * weighbridge slip are captured at all: an EPR-registered handler of end-of-life
 * batteries has to be able to show the chain of custody by weight. They are
 * recorded here, at the one moment the batteries are physically in front of
 * someone.
 */

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { ValidationError } from "./errors";
import type { BuybackTx } from "./tx";

// The pure half lives in variance.ts so it can be tested without a database.
// Re-exported here so callers have one import for "pickup things".
export {
  computeVariance,
  type ActualCount,
  type ExpectedCount,
  type LineVariance,
  type VarianceResult,
} from "./variance";

/**
 * Refuse a dealer payout while a count variance is unacknowledged (M05 AC).
 *
 * Only the DEALER leg is gated. The vendor's receipt has nothing to do with what
 * the dealer handed over, and blocking money coming IN because of a dispute about
 * money going OUT would be nonsense.
 */
export async function assertPayoutAllowed(
  dealId: string,
  leg: "DEALER" | "VENDOR",
  runner: BuybackTx | typeof db = db,
): Promise<void> {
  if (leg !== "DEALER") return;

  const rows = await runner.execute(sql`
    SELECT id, variance_note, variance_ack_required, dealer_ack_at
    FROM pickups
    WHERE deal_id = ${dealId}
      AND variance_ack_required = TRUE
      AND dealer_ack_at IS NULL
    LIMIT 1
  `);

  const blocked = (rows as unknown as Array<Record<string, unknown>>)[0];
  if (!blocked) return;

  throw new ValidationError(
    `The dealer has not yet acknowledged the count variance on this pickup ` +
      `(${String(blocked.variance_note ?? "counts differ from what was declared")}). ` +
      `Paying out now means arguing about money that has already left. Wait for their ` +
      `acknowledgement, or correct the counts.`,
    {
      code: "VARIANCE_UNACKNOWLEDGED",
      pickup_id: blocked.id,
      variance_note: blocked.variance_note,
    },
  );
}

/**
 * Ext-8 — the dealer list's pickup summary, BATCHED for one dealer entity and
 * keyed by request id (latest pickup per deal, if several).
 *
 * Selects ONLY the columns the dealer-safe source shape names: schedule,
 * address, contact, and the two count sums off the completion JSON. The BWM
 * compliance S3 keys (eway_bill_s3, weighbridge_slip_s3) and created_by exist
 * on the table but are never in this SELECT — and toDealerPickup() would strip
 * them even if they were. Two independent barriers.
 *
 * Counts: Σ quantity over the expected/actual JSONB written at completion.
 * NULL until the pickup completes (jsonb_array_elements over NULL yields no
 * rows, and sum() over no rows is NULL) — a scheduled pickup has no counts,
 * and "0/0 units" would be a lie.
 */
export async function dealerPickupSourcesForEntity(
  entityId: string,
): Promise<
  Map<
    string,
    {
      scheduled_at: Date | string | null;
      completed_at: Date | string | null;
      address: string | null;
      contact_name: string | null;
      contact_phone: string | null;
      submitted_units: number | null;
      actual_units: number | null;
    }
  >
> {
  const rows = await db.execute(sql`
    SELECT DISTINCT ON (p.deal_id)
      bd.request_id,
      p.scheduled_at,
      p.completed_at,
      p.address,
      p.contact_name,
      p.contact_phone,
      (SELECT sum((e.item->>'quantity')::int)
         FROM jsonb_array_elements(p.expected_counts) AS e(item))::int AS submitted_units,
      (SELECT sum((a.item->>'quantity')::int)
         FROM jsonb_array_elements(p.actual_counts) AS a(item))::int AS actual_units
    FROM pickups p
    JOIN buyback_deals bd    ON bd.id = p.deal_id
    JOIN buyback_requests br ON br.id = bd.request_id
    WHERE br.dealer_entity_id = ${entityId}
    ORDER BY p.deal_id, p.created_at DESC
  `);

  const byRequest = new Map<
    string,
    {
      scheduled_at: Date | string | null;
      completed_at: Date | string | null;
      address: string | null;
      contact_name: string | null;
      contact_phone: string | null;
      submitted_units: number | null;
      actual_units: number | null;
    }
  >();

  for (const r of rows as unknown as Array<Record<string, unknown>>) {
    byRequest.set(String(r.request_id), {
      scheduled_at: (r.scheduled_at as Date | string) ?? null,
      completed_at: (r.completed_at as Date | string) ?? null,
      address: (r.address as string) ?? null,
      contact_name: (r.contact_name as string) ?? null,
      contact_phone: (r.contact_phone as string) ?? null,
      submitted_units: r.submitted_units === null ? null : Number(r.submitted_units),
      actual_units: r.actual_units === null ? null : Number(r.actual_units),
    });
  }

  return byRequest;
}

/** The expected counts for a deal, from the lines themselves. */
export async function expectedCounts(
  requestId: string,
  runner: BuybackTx | typeof db = db,
): Promise<ExpectedCount[]> {
  const rows = await runner.execute(sql`
    SELECT bl.id AS line_id, bl.quantity, bl.condition, cv.voltage, cv.ah
    FROM buyback_lines bl
    JOIN buyback_batches bb  ON bb.id = bl.batch_id
    JOIN catalog_variants cv ON cv.id = bl.variant_id
    WHERE bb.request_id = ${requestId}
    ORDER BY cv.voltage, cv.ah
  `);

  return (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
    line_id: String(r.line_id),
    label: `${r.voltage}V ${r.ah}Ah · ${r.condition === "WORKING" ? "Working" : "Dead"}`,
    quantity: Number(r.quantity),
  }));
}
