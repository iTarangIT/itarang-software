/**
 * PUT /api/admin/buyback/requests/:id/owner   { owner_id: string | null }
 *
 * E-302 (review R-12) — Claim a request (owner_id = yourself) or assign it to
 * anyone who works buyback; null unassigns. The owner is who the Buyback Daily
 * mail credits the request's kg, quotes and pickups to, so it is set by a
 * person on purpose — never inferred from "whoever acted last".
 *
 * Not a state-machine transition: ownership can change in any deal state,
 * closed ones included (a report may need correcting after the fact). The
 * change is still written to buyback_activity_log, hidden from the dealer.
 */

import { z } from "zod";

import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireBuybackAdmin } from "@/lib/buyback/auth";
import { BuybackOwnerError, setBuybackRequestOwner } from "@/lib/buyback/owner";

export const runtime = "nodejs";

// "me" = claim: resolved to the caller on the server, so the page never needs
// to know its own user id.
const BodySchema = z.object({
  owner_id: z.string().trim().min(1).max(64).nullable(),
});

export const PUT = withErrorHandler(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: requestId } = await ctx.params;
    const actor = await requireBuybackAdmin();
    const { owner_id } = BodySchema.parse(await req.json());
    try {
      const target = owner_id === "me" ? actor.id : owner_id;
      const result = await setBuybackRequestOwner(requestId, target, actor);
      return successResponse(result);
    } catch (e) {
      if (e instanceof BuybackOwnerError) return errorResponse(e.message, 400);
      throw e;
    }
  },
);
