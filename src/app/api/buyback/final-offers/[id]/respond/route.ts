/**
 * POST /api/buyback/final-offers/:id/respond   { response: "ACCEPT" | "DECLINE" }
 *
 * The dealer's ONE binary answer to the whole itemized set (BRD U5). There is
 * deliberately no per-line accept: the offer is a package, and letting a dealer
 * cherry-pick lines would break the margin arithmetic the vendor leg depends on.
 *
 * ACCEPT  → DEALER_ACCEPTED (provisional until the vendor agrees)
 * DECLINE → back to NEGOTIATING
 */

import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { buybackDeals, buybackRequests, finalOffers } from "@/lib/db/schema";
import { requireDealer } from "@/lib/buyback/auth";
import { NotFoundError, ValidationError } from "@/lib/buyback/errors";
import { applyTransition, loadDealForUpdate } from "@/lib/buyback/transition";

export const runtime = "nodejs";

const bodySchema = z.object({
  response: z.enum(["ACCEPT", "DECLINE"]),
});

export const POST = withErrorHandler(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: offerId } = await ctx.params;
    const actor = await requireDealer();
    const body = bodySchema.parse(await req.json());

    // The offer must belong to a request this dealer owns. Scoped in the query,
    // so another dealer's offer id 404s rather than 403s.
    const [row] = await db
      .select({
        offer_id: finalOffers.id,
        offer_status: finalOffers.status,
        version_no: finalOffers.version_no,
        deal_id: buybackDeals.id,
        request_id: buybackRequests.id,
        request_no: buybackRequests.request_no,
      })
      .from(finalOffers)
      .innerJoin(buybackDeals, eq(finalOffers.deal_id, buybackDeals.id))
      .innerJoin(buybackRequests, eq(buybackDeals.request_id, buybackRequests.id))
      .where(
        and(
          eq(finalOffers.id, offerId),
          eq(buybackRequests.dealer_entity_id, actor.entityId!),
        ),
      )
      .limit(1);

    if (!row) throw new NotFoundError("Final offer not found.");

    const outcome = await db.transaction(async (tx) => {
      const deal = await loadDealForUpdate(tx, row.request_id);
      if (!deal) throw new NotFoundError("Deal not found.");

      // An offer from a superseded version cannot be answered — if the admin
      // reopened, the dealer is answering an offer that no longer stands.
      if (row.version_no !== deal.offer_version) {
        throw new ValidationError(
          `This offer (v${row.version_no}) has been superseded by v${deal.offer_version}. Reload to see the current offer.`,
        );
      }
      if (row.offer_status !== "SENT") {
        throw new ValidationError(`This offer has already been ${row.offer_status.toLowerCase()}.`);
      }

      await tx
        .update(finalOffers)
        .set({
          status: body.response === "ACCEPT" ? "ACCEPTED" : "DECLINED",
          responded_at: new Date(),
        })
        .where(eq(finalOffers.id, row.offer_id));

      return applyTransition({
        tx,
        dealId: deal.id,
        requestId: row.request_id,
        currentStatus: deal.status,
        offerVersion: deal.offer_version,
        action: body.response === "ACCEPT" ? "dealer_accept" : "dealer_decline",
        actor: { id: actor.id, role: "dealer" },
        after: { final_offer_id: row.offer_id, response: body.response },
        notificationPayload: {
          request_no: row.request_no,
          version_no: row.version_no,
          response: body.response,
        },
      });
    });

    return successResponse({
      request_id: row.request_id,
      final_offer_id: row.offer_id,
      status: outcome.to,
    });
  },
);
