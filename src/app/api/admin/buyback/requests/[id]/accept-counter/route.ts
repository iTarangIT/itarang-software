/**
 * POST /api/admin/buyback/requests/:id/accept-counter
 *
 * The admin accepts the dealer's standing counter directly, mid-negotiation
 * (NEGOTIATING → DEALER_ACCEPTED) — the "yes" that previously existed only via
 * send_final_offer. See acceptStandingCounter for why it snapshots an ACCEPTED
 * final offer, and why every downstream money path is unchanged.
 */

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { loadAnyRequest, requireBuybackAdmin } from "@/lib/buyback/auth";
import { acceptStandingCounter } from "@/lib/buyback/dealer-accept";
import { NotFoundError, TransitionError } from "@/lib/buyback/errors";
import { loadDealForUpdate } from "@/lib/buyback/transition";

export const runtime = "nodejs";

export const POST = withErrorHandler(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: requestId } = await ctx.params;
    const actor = await requireBuybackAdmin();
    const request = await loadAnyRequest(requestId);

    const outcome = await db.transaction(async (tx) => {
      const deal = await loadDealForUpdate(tx, request.id);
      if (!deal) throw new NotFoundError("Deal not found.");
      if (deal.status !== "NEGOTIATING") {
        throw new TransitionError(
          `The deal is ${deal.status}. A counter can only be accepted while the deal is negotiating.`,
        );
      }
      return acceptStandingCounter({
        tx,
        dealId: deal.id,
        requestId: request.id,
        requestNo: request.request_no,
        offerVersion: deal.offer_version,
        acceptedBy: "admin",
        actor: { id: actor.id, role: "admin" },
      });
    });

    return successResponse({
      request_id: request.id,
      status: outcome.status,
      final_offer_id: outcome.final_offer_id,
      total: outcome.total,
    });
  },
);
