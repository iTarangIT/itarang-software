/**
 * POST /api/buyback/requests/:id/resubmit
 *
 * INFO_REQUESTED → UNDER_REVIEW. The dealer has supplied what the admin asked
 * for, so the ball goes back to iTarang and the four review actions go live again.
 *
 * The submit gate runs again — an info loop must not be a way to sneak a request
 * through with four photos on a line the dealer edited in the meantime.
 *
 * Resolving the open info request is part of the same transaction as the state
 * change: an INFO_REQUESTED banner that outlives its own request would tell the
 * dealer to send documents they already sent.
 */

import { and, eq, isNull } from "drizzle-orm";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { infoRequests } from "@/lib/db/schema";
import { loadOwnRequest, requireDealer } from "@/lib/buyback/auth";
import { NotFoundError, ValidationError } from "@/lib/buyback/errors";
import { linesForRequest, toGateLines } from "@/lib/buyback/queries";
import { checkSubmitReadiness } from "@/lib/buyback/submit-gate";
import { applyTransition, loadDealForUpdate } from "@/lib/buyback/transition";

export const runtime = "nodejs";

export const POST = withErrorHandler(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: requestId } = await ctx.params;
    const actor = await requireDealer();
    const request = await loadOwnRequest(actor, requestId);

    const outcome = await db.transaction(async (tx) => {
      const deal = await loadDealForUpdate(tx, request.id);
      if (!deal) throw new NotFoundError("Deal not found.");

      const lines = await linesForRequest(request.id, tx);
      const gate = checkSubmitReadiness(toGateLines(lines));

      if (!gate.ok) {
        // The structured issues ride along in `details`, so the intake page can
        // highlight the offending lines instead of printing a paragraph.
        throw new ValidationError(
          `This request is still incomplete: ${gate.issues.map((i) => i.message).join(" ")}`,
          gate.issues,
        );
      }

      const result = await applyTransition({
        tx,
        dealId: deal.id,
        requestId: request.id,
        currentStatus: deal.status,
        offerVersion: deal.offer_version,
        action: "resubmit",
        actor: { id: actor.id, role: "dealer" },
        notificationPayload: { request_no: request.request_no },
      });

      // Close the open info request in the SAME transaction as the transition.
      await tx
        .update(infoRequests)
        .set({ resolved_at: new Date() })
        .where(
          and(
            eq(infoRequests.request_id, request.id),
            isNull(infoRequests.resolved_at),
          ),
        );

      return result;
    });

    return successResponse({ request_id: request.id, status: outcome.to });
  },
);
