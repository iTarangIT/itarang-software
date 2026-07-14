/**
 * POST /api/buyback/requests/:id/submit
 *
 * DRAFT → SUBMITTED. The gate that the prototype didn't have: ≥1 line, ≥5 photos
 * on every line, provenance on every line. A request that fails it is refused
 * with the specific reasons, per line, so the dealer knows exactly what to fix.
 *
 * Everything (status, audit row, notification) happens in one transaction via
 * applyTransition.
 */

import { eq } from "drizzle-orm";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { buybackRequests } from "@/lib/db/schema";
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

      // The gate. Read inside the transaction so a photo deleted mid-submit
      // cannot slip an incomplete request through.
      const lines = await linesForRequest(request.id, tx);
      const gate = checkSubmitReadiness(toGateLines(lines));

      if (!gate.ok) {
        // The structured issues ride along in `details`, so the intake page can
        // highlight the offending lines instead of printing a paragraph.
        throw new ValidationError(
          `This request is not ready to submit: ${gate.issues.map((i) => i.message).join(" ")}`,
          gate.issues,
        );
      }

      const result = await applyTransition({
        tx,
        dealId: deal.id,
        requestId: request.id,
        currentStatus: deal.status,
        offerVersion: deal.offer_version,
        action: "submit",
        actor: { id: actor.id, role: "dealer" },
        after: {
          status: "SUBMITTED",
          lines: lines.length,
          units: lines.reduce((n, l) => n + l.quantity, 0),
        },
        notificationPayload: {
          request_no: request.request_no,
          line_count: lines.length,
        },
      });

      await tx
        .update(buybackRequests)
        .set({ submitted_at: new Date(), updated_at: new Date() })
        .where(eq(buybackRequests.id, request.id));

      return result;
    });

    return successResponse({
      request_id: request.id,
      request_no: request.request_no,
      status: outcome.to,
    });
  },
);
