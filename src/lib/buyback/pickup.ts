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
