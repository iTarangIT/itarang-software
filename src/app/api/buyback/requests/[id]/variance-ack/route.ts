/**
 * POST /api/buyback/requests/:id/variance-ack   (M05 AC)
 *
 * The dealer acknowledges that we collected fewer (or more) batteries than they
 * declared. This is the ONLY thing that lifts the payout block.
 *
 * It is a dealer action, deliberately. An admin clearing their own variance would
 * make the gate decorative — the whole point is that the counterparty agrees to
 * the number before the money moves. Paying out first and arguing afterwards means
 * arguing about money that has already left the building.
 *
 * There is no "dispute" branch in v1. If the dealer disagrees with the count, they
 * do not acknowledge, the payout stays blocked, and a human sorts it out — which
 * is the correct outcome, and better than a workflow that pretends a disagreement
 * about physical goods can be resolved in software.
 */

import { and, eq, isNull, sql } from "drizzle-orm";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { pickups } from "@/lib/db/schema";
import { loadOwnRequest, requireDealer } from "@/lib/buyback/auth";
import { NotFoundError, ValidationError } from "@/lib/buyback/errors";
import { recordActivity } from "@/lib/buyback/transition";

export const runtime = "nodejs";

export const GET = withErrorHandler(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: requestId } = await ctx.params;
    const actor = await requireDealer();
    const request = await loadOwnRequest(actor, requestId);

    const rows = await db.execute(sql`
      SELECT p.id, p.variance_note, p.expected_counts, p.actual_counts,
             p.variance_ack_required, p.dealer_ack_at
      FROM pickups p
      JOIN buyback_deals bd ON bd.id = p.deal_id
      WHERE bd.request_id = ${request.id}
        AND p.variance_flag = TRUE
      ORDER BY p.created_at DESC
      LIMIT 1
    `);

    const row = (rows as unknown as Array<Record<string, unknown>>)[0];

    return successResponse({
      request_id: request.id,
      variance: row
        ? {
            pickup_id: row.id,
            note: row.variance_note,
            expected: row.expected_counts,
            actual: row.actual_counts,
            needs_ack: row.variance_ack_required === true && row.dealer_ack_at === null,
            acknowledged_at: row.dealer_ack_at,
          }
        : null,
    });
  },
);

export const POST = withErrorHandler(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: requestId } = await ctx.params;
    const actor = await requireDealer();
    const request = await loadOwnRequest(actor, requestId);

    const result = await db.transaction(async (tx) => {
      const deal = await tx.execute(sql`
        SELECT id FROM buyback_deals WHERE request_id = ${request.id} LIMIT 1
      `);
      const dealId = (deal as unknown as Array<{ id: string }>)[0]?.id;
      if (!dealId) throw new NotFoundError("Deal not found.");

      const open = await tx
        .select({ id: pickups.id, note: pickups.variance_note })
        .from(pickups)
        .where(
          and(
            eq(pickups.deal_id, dealId),
            eq(pickups.variance_ack_required, true),
            isNull(pickups.dealer_ack_at),
          ),
        )
        .limit(1);

      if (open.length === 0) {
        throw new ValidationError("There is no count variance awaiting your acknowledgement.");
      }

      await tx
        .update(pickups)
        .set({ dealer_ack_at: new Date(), updated_at: new Date() })
        .where(eq(pickups.id, open[0].id));

      // The gate lifting is a real change, and it is what unblocks the money — so
      // it is audited. It moves no deal status, hence recordActivity rather than a
      // transition (M21: activity_log records every CHANGE, not every transition).
      await recordActivity({
        tx,
        requestId: request.id,
        dealId,
        actor: { id: actor.id, role: "dealer" },
        action: "acknowledge_variance",
        before: { variance_acknowledged: false, note: open[0].note },
        after: { variance_acknowledged: true, note: open[0].note },
      });

      return { pickupId: open[0].id, note: open[0].note };
    });

    return successResponse({
      request_id: request.id,
      pickup_id: result.pickupId,
      acknowledged: true,
      message: "Thank you — the count is confirmed. Your payout is no longer held.",
    });
  },
);
