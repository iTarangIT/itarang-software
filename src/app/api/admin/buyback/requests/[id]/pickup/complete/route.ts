/**
 * POST /api/admin/buyback/requests/:id/pickup/complete   (M05 + BWM 2022)
 *
 * PICKUP_SCHEDULED → PICKED_UP. The batteries are now physically iTarang's.
 *
 * That is why the state machine has no `cancel` out of PICKED_UP: undoing a
 * collection is a RETURN, not a cancellation, and v1 has no returns flow.
 *
 * WHAT THIS ROUTE ACTUALLY GUARDS (M05 AC — "dealer WhatsApp ack on variance
 * before payout"): the collector counts what is on the truck. If that count
 * differs from what the dealer declared, a VARIANCE is raised, the dealer is told
 * on WhatsApp, and their payout is BLOCKED until they acknowledge it
 * (assertPayoutAllowed, called by the settlement route).
 *
 * Paying out first and arguing afterwards means arguing about money that has
 * already left the building. That conversation has no good ending, so the gate is
 * before the money, not after.
 *
 * BWM 2022 fields — the e-way bill number and the weighbridge slip — are captured
 * here because this is the one moment the batteries are physically in front of
 * someone who can read them off. An EPR-registered handler of end-of-life
 * batteries has to be able to show the chain of custody by weight.
 */

import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { pickups } from "@/lib/db/schema";
import { loadAnyRequest, requireBuybackAdmin } from "@/lib/buyback/auth";
import { NotFoundError, ValidationError } from "@/lib/buyback/errors";
import { computeVariance, expectedCounts } from "@/lib/buyback/pickup";
import { applyTransition, loadDealForUpdate } from "@/lib/buyback/transition";

export const runtime = "nodejs";

const bodySchema = z.object({
  /** What was ACTUALLY on the truck, per line. Omit a line and it counts as zero. */
  actual_counts: z
    .array(z.object({ line_id: z.string().uuid(), quantity: z.number().int().min(0) }))
    .optional(),
  /** BWM 2022 chain of custody. */
  eway_bill_no: z.string().max(64).optional(),
  eway_bill_s3: z.string().max(500).optional(),
  weighbridge_slip_s3: z.string().max(500).optional(),
  note: z.string().max(1000).optional(),
});

export const POST = withErrorHandler(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: requestId } = await ctx.params;
    const actor = await requireBuybackAdmin();
    const request = await loadAnyRequest(requestId);
    const body = bodySchema.parse(await req.json().catch(() => ({})));

    const outcome = await db.transaction(async (tx) => {
      const deal = await loadDealForUpdate(tx, request.id);
      if (!deal) throw new NotFoundError("Deal not found.");

      const open = await tx
        .select({ id: pickups.id })
        .from(pickups)
        .where(and(eq(pickups.deal_id, deal.id), isNull(pickups.completed_at)))
        .limit(1);

      if (open.length === 0) {
        throw new ValidationError("There is no scheduled pickup on this deal to complete.");
      }

      const expected = await expectedCounts(request.id, tx);

      // No counts supplied means "everything the dealer declared was there". That
      // is the honest default: recording a variance nobody actually observed would
      // block a payout for no reason.
      const actual = body.actual_counts ?? expected.map((e) => ({
        line_id: e.line_id,
        quantity: e.quantity,
      }));

      const variance = computeVariance(expected, actual);

      await tx
        .update(pickups)
        .set({
          completed_at: new Date(),
          expected_counts: expected as never,
          actual_counts: actual as never,
          variance_flag: variance.hasVariance,
          variance_note: variance.summary,
          // THE GATE. Set here, cleared only by the dealer's acknowledgement.
          variance_ack_required: variance.hasVariance,
          eway_bill_no: body.eway_bill_no ?? null,
          eway_bill_s3: body.eway_bill_s3 ?? null,
          weighbridge_slip_s3: body.weighbridge_slip_s3 ?? null,
          updated_at: new Date(),
        })
        .where(eq(pickups.id, open[0].id));

      const result = await applyTransition({
        tx,
        dealId: deal.id,
        requestId: request.id,
        currentStatus: deal.status,
        offerVersion: deal.offer_version,
        action: "complete_pickup",
        actor: { id: actor.id, role: "admin" },
        after: {
          pickup_id: open[0].id,
          expected_units: variance.totalExpected,
          actual_units: variance.totalActual,
          variance: variance.hasVariance ? variance.summary : null,
          eway_bill_no: body.eway_bill_no ?? null,
        },
        // The dealer is told either way — but a variance changes the message from
        // "collected, invoice us" to "collected, but the count differs; confirm
        // before we can pay you".
        notificationPayload: {
          request_no: request.request_no,
          kind: variance.hasVariance ? "pickup_variance" : "pickup_done",
          variance: variance.summary,
          expected_units: variance.totalExpected,
          actual_units: variance.totalActual,
        },
      });

      return {
        pickupId: open[0].id,
        status: result.to,
        variance,
      };
    });

    return successResponse({
      request_id: request.id,
      pickup_id: outcome.pickupId,
      status: outcome.status,
      variance_flag: outcome.variance.hasVariance,
      variance: outcome.variance.summary,
      // The admin must know the payout is now blocked, or they will wonder why the
      // settlement button refuses them ten minutes later.
      payout_blocked_pending_dealer_ack: outcome.variance.hasVariance,
      lines: outcome.variance.lines,
    });
  },
);
