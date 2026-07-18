/**
 * POST /api/buyback/requests/:id/accept-counter
 *
 * The dealer accepts iTarang's standing counter directly, mid-negotiation
 * (NEGOTIATING → DEALER_ACCEPTED) — instead of waiting for a formal final offer.
 * Scoped to the dealer's OWN request (loadOwnRequest). See acceptStandingCounter.
 */

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { loadOwnRequest, requireDealer } from "@/lib/buyback/auth";
import { acceptStandingCounter } from "@/lib/buyback/dealer-accept";
import { NotFoundError, TransitionError } from "@/lib/buyback/errors";
import { loadDealForUpdate } from "@/lib/buyback/transition";

export const runtime = "nodejs";

export const POST = withErrorHandler(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: requestId } = await ctx.params;
    const actor = await requireDealer();
    const request = await loadOwnRequest(actor, requestId);

    const outcome = await db.transaction(async (tx) => {
      const deal = await loadDealForUpdate(tx, request.id);
      if (!deal) throw new NotFoundError("Deal not found.");
      if (deal.status !== "NEGOTIATING") {
        throw new TransitionError(
          `This deal is ${deal.status}. You can only accept an offer while it is being negotiated.`,
        );
      }
      return acceptStandingCounter({
        tx,
        dealId: deal.id,
        requestId: request.id,
        requestNo: request.request_no,
        offerVersion: deal.offer_version,
        acceptedBy: "dealer",
        actor: { id: actor.id, role: "dealer" },
      });
    });

    return successResponse({
      request_id: request.id,
      status: outcome.status,
      total: outcome.total,
    });
  },
);
