/**
 * POST /api/admin/buyback/requests/:id/close
 *
 * SETTLED → CLOSED. Terminal.
 *
 * Deliberately a separate, human act rather than an automatic consequence of the
 * second settlement. CLOSED is the state that M15 asserts a complete document set
 * against and that M14 reconciles margin on — so a person confirms the deal is
 * genuinely finished, instead of it closing itself the instant money lands.
 *
 * The reconciliation is checked HERE, at the boundary, because CLOSED is the last
 * moment anything can be fixed. If the ledger and the locks disagree, closing the
 * deal would bake a wrong margin into every report that reads it. So the close is
 * refused and someone looks.
 */

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { loadAnyRequest, requireBuybackAdmin } from "@/lib/buyback/auth";
import { NotFoundError, ValidationError } from "@/lib/buyback/errors";
import { inr } from "@/lib/buyback/format";
import {
  dealMoney,
  plannedMargin,
  realisedMargin,
  settlementsForDeal,
} from "@/lib/buyback/money";
import { dealHeader } from "@/lib/buyback/queries";
import { applyTransition, loadDealForUpdate } from "@/lib/buyback/transition";

export const runtime = "nodejs";

export const POST = withErrorHandler(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: requestId } = await ctx.params;
    const actor = await requireBuybackAdmin();
    const request = await loadAnyRequest(requestId);

    const header = await dealHeader(request.id);
    if (!header) throw new NotFoundError("Deal not found.");

    const outcome = await db.transaction(async (tx) => {
      const deal = await loadDealForUpdate(tx, request.id);
      if (!deal) throw new NotFoundError("Deal not found.");

      const money = await dealMoney(deal.id, tx);
      const settlements = await settlementsForDeal(deal.id, tx);

      // M14's reconciliation invariant, checked at the boundary:
      //
      //   ledger net (IN − OUT)  ==  Σ qty × (vendor_price − dealer_price)
      //
      // NOT against margin_value. That is the margin we PLANNED — the uplift we
      // added when setting the ask. A vendor may agree ABOVE the ask (haggle them
      // up ₹50/unit and we earn more than we planned), so reconciling against the
      // planned figure would refuse to close perfectly good deals and would make
      // every dashboard understate what iTarang actually earned.
      //
      // The two sides come from genuinely independent places: one from what was
      // PAID, one from what was AGREED and frozen in the locks. If they disagree,
      // something is wrong that a report will otherwise repeat forever — so we
      // refuse to close, rather than closing and being quietly wrong.
      const net = settlements
        .filter((s) => s.closed_at)
        .reduce((sum, s) => sum + (s.direction === "IN" ? 1 : -1) * Number(s.amount), 0);

      const expected = realisedMargin(money);

      if (expected === null) {
        throw new ValidationError(
          "This deal has no agreed vendor price, so its margin cannot be reconciled.",
        );
      }

      if (Math.round(net * 100) !== Math.round(expected * 100)) {
        throw new ValidationError(
          `This deal will not reconcile. The money that actually moved nets to ${inr(net)}, ` +
            `but the locked prices say the margin should be ${inr(expected)}. Closing it would ` +
            `bake a wrong margin into every report that reads this deal. Check the settlements ` +
            `before closing.`,
          {
            code: "RECONCILIATION_FAILED",
            ledger_net: net,
            expected_margin: expected,
            difference: net - expected,
          },
        );
      }

      const planned = plannedMargin(money);

      const result = await applyTransition({
        tx,
        dealId: deal.id,
        requestId: request.id,
        currentStatus: deal.status,
        offerVersion: deal.offer_version,
        action: "close_deal",
        actor: { id: actor.id, role: "admin" },
        after: {
          realised_margin: net,
          planned_margin: planned,
          // Positive when we haggled the vendor above our ask. Worth recording:
          // it is the only place the negotiation's value shows up as a number.
          uplift: net - planned,
          reconciled: true,
        },
        notificationPayload: { request_no: request.request_no, realised_margin: net },
      });

      return { status: result.to, margin: net, planned };
    });

    return successResponse({
      request_id: request.id,
      status: outcome.status,
      realised_margin: outcome.margin,
      realised_margin_label: inr(outcome.margin),
      planned_margin: outcome.planned,
      uplift: outcome.margin - outcome.planned,
    });
  },
);
