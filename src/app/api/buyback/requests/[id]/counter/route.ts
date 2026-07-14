/**
 * POST /api/buyback/requests/:id/counter
 *
 * The dealer's counter-offer — itemized per SKU, exactly like the admin's.
 *
 * The prototype's dealer composer was a single "Enter your counter ₹/unit…" box,
 * i.e. a lump sum. BRD P5 forbids that on BOTH sides, and the schema enforces it:
 * negotiation_rounds has no amount column, so there is nowhere to put a total.
 *
 * Stays in NEGOTIATING (a self-loop) and appends a round.
 */

import { z } from "zod";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { negotiationRoundLines, negotiationRounds } from "@/lib/db/schema";
import { loadOwnRequest, requireDealer } from "@/lib/buyback/auth";
import { NotFoundError, ValidationError } from "@/lib/buyback/errors";
import { linesForRequest, nextRoundNo } from "@/lib/buyback/queries";
import { applyTransition, loadDealForUpdate } from "@/lib/buyback/transition";

export const runtime = "nodejs";

const bodySchema = z.object({
  lines: z
    .array(
      z.object({
        line_id: z.string().uuid(),
        price_per_unit: z.number().nonnegative(),
      }),
    )
    .min(1),
  note: z.string().max(2000).nullish(),
});

export const POST = withErrorHandler(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: requestId } = await ctx.params;
    const actor = await requireDealer();
    const request = await loadOwnRequest(actor, requestId);
    const body = bodySchema.parse(await req.json());

    const outcome = await db.transaction(async (tx) => {
      const deal = await loadDealForUpdate(tx, request.id);
      if (!deal) throw new NotFoundError("Deal not found.");

      const allLines = await linesForRequest(request.id, tx);
      const priced = new Set(body.lines.map((l) => l.line_id));

      if (priced.size !== allLines.length || allLines.some((l) => !priced.has(l.id))) {
        throw new ValidationError(
          "A counter must price every battery line on the request.",
        );
      }

      const roundNo = await nextRoundNo(tx, deal.id, "DEALER");

      const [round] = await tx
        .insert(negotiationRounds)
        .values({
          deal_id: deal.id,
          leg: "DEALER",
          counterparty_id: request.dealer_entity_id,
          round_no: roundNo,
          offered_by: actor.id,
          offered_by_role: "dealer",
          note: body.note ?? null,
        })
        .returning();

      await tx.insert(negotiationRoundLines).values(
        body.lines.map((l) => ({
          round_id: round.id,
          line_id: l.line_id,
          offered_price_per_unit: l.price_per_unit.toString(),
        })),
      );

      return applyTransition({
        tx,
        dealId: deal.id,
        requestId: request.id,
        currentStatus: deal.status,
        offerVersion: deal.offer_version,
        action: "dealer_counter",
        actor: { id: actor.id, role: "dealer" },
        after: { round_no: roundNo, lines: body.lines },
        // A dealer counters repeatedly within one offer version. Without the
        // round number, the second counter's notification would collide with the
        // first's idempotency key and be silently swallowed.
        eventDiscriminator: roundNo,
        notificationPayload: {
          request_no: request.request_no,
          round_no: roundNo,
          lines: body.lines,
        },
      });
    });

    return successResponse({ request_id: request.id, status: outcome.to });
  },
);
