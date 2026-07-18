/**
 * POST /api/admin/buyback/requests/:id/counter   (item 7)
 *
 * The admin's counter-offer within an open negotiation — itemized per SKU, the
 * exact mirror of the dealer's /counter.
 *
 * This is the fix for "remove the Send final offer button". The desk was not
 * asking to delete the final-offer artifact — they were asking to stop being
 * forced into it: before this, once a deal reached NEGOTIATING the admin could
 * only `send_final_offer` to name another price, while the dealer could counter
 * as often as they liked. Now both sides counter symmetrically; send_final_offer
 * stays for what it is, a deliberate last word.
 *
 * NO deal_line_locks write. A counter is a negotiation round, and
 * negotiation_rounds has no amount column — the prices live per SKU on
 * negotiation_round_lines, so a lump sum is unrepresentable (BRD P5). The money
 * is only locked later, at set_margin. This route cannot touch the ledger.
 */

import { z } from "zod";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { negotiationRoundLines, negotiationRounds } from "@/lib/db/schema";
import { loadAnyRequest, requireBuybackAdmin } from "@/lib/buyback/auth";
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
    const actor = await requireBuybackAdmin();
    const request = await loadAnyRequest(requestId);
    const body = bodySchema.parse(await req.json());

    const outcome = await db.transaction(async (tx) => {
      const deal = await loadDealForUpdate(tx, request.id);
      if (!deal) throw new NotFoundError("Deal not found.");

      const allLines = await linesForRequest(request.id, tx);
      const priced = new Set(body.lines.map((l) => l.line_id));

      if (priced.size !== allLines.length || allLines.some((l) => !priced.has(l.id))) {
        throw new ValidationError("A counter must price every battery line on the request.");
      }

      // The negotiation round is on the DEALER leg — this is the iTarang<->dealer
      // haggle, same table the dealer's counters land on. offered_by_role='admin'
      // is what tells the timeline (and the dealer's activity filter) that this
      // came from the desk, not the dealer.
      const roundNo = await nextRoundNo(tx, deal.id, "DEALER");

      const [round] = await tx
        .insert(negotiationRounds)
        .values({
          deal_id: deal.id,
          leg: "DEALER",
          counterparty_id: request.dealer_entity_id,
          round_no: roundNo,
          offered_by: actor.id,
          offered_by_role: "admin",
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
        action: "admin_counter",
        actor: { id: actor.id, role: "admin" },
        after: { round_no: roundNo, lines: body.lines },
        // The admin, like the dealer, may counter repeatedly within one version.
        // Without the round number the second counter's notification collides
        // with the first's idempotency key and is silently swallowed.
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
