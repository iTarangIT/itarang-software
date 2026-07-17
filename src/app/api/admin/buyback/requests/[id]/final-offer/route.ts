/**
 * POST /api/admin/buyback/requests/:id/final-offer
 *
 * The itemized, versioned final offer (BRD M07/U5).
 *
 * Per-line prices, ONE overall answer from the dealer. The header row carries no
 * amount — the schema makes a lump-sum final offer impossible — and the offer is
 * stamped with the deal's current offer_version, so a reopen produces v2 rather
 * than mutating v1. The v1 rows stay on disk for the audit trail.
 */

import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { finalOfferLines, finalOffers } from "@/lib/db/schema";
import { loadAnyRequest, requireBuybackAdmin } from "@/lib/buyback/auth";
import { NotFoundError, ValidationError } from "@/lib/buyback/errors";
import { linesForRequest } from "@/lib/buyback/queries";
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

      // Every line must be priced. A final offer that silently omits a line
      // would leave that battery with no agreed price, which is exactly the
      // ambiguity the per-SKU rule exists to kill.
      const priced = new Set(body.lines.map((l) => l.line_id));
      const missing = allLines.filter((l) => !priced.has(l.id));
      if (missing.length > 0) {
        throw new ValidationError(
          `The final offer must price every battery line. ${missing.length} line(s) are unpriced.`,
        );
      }
      if (priced.size !== allLines.length) {
        throw new ValidationError("The final offer prices a line that is not on this request.");
      }

      // One offer per version. Re-sending at the same version replaces the
      // dealer's outstanding one rather than creating a duplicate they could
      // accept twice.
      //
      // NOT `status = 'SENT'`, which was a dead end: dealer_decline moves the
      // deal to NEGOTIATING WITHOUT bumping offer_version and leaves a DECLINED
      // row at that version. Deleting only SENT rows left it there, so the
      // INSERT below collided with final_offers_deal_version_unique and 500'd —
      // and `reopen` is refused from NEGOTIATING (it is not in
      // REOPENABLE_STATES), so the admin could neither re-offer nor reopen. A
      // declined deal was stuck forever. It has never happened only because
      // dealer_decline has been used zero times.
      //
      // ACCEPTED is excluded and must stay excluded: it is the record of what
      // the dealer actually agreed to, and deal_line_locks reads its prices.
      // Deleting one would erase the basis of a deal in flight. It also cannot
      // collide — send_final_offer is illegal from DEALER_ACCEPTED anyway.
      await tx
        .delete(finalOffers)
        .where(
          and(
            eq(finalOffers.deal_id, deal.id),
            eq(finalOffers.version_no, deal.offer_version),
            ne(finalOffers.status, "ACCEPTED"),
          ),
        );

      const [offer] = await tx
        .insert(finalOffers)
        .values({
          deal_id: deal.id,
          version_no: deal.offer_version,
          status: "SENT",
          note: body.note ?? null,
          sent_by: actor.id,
        })
        .returning();

      await tx.insert(finalOfferLines).values(
        body.lines.map((l) => ({
          final_offer_id: offer.id,
          line_id: l.line_id,
          price_per_unit: l.price_per_unit.toString(),
        })),
      );

      const total = body.lines.reduce((sum, l) => {
        const line = allLines.find((x) => x.id === l.line_id)!;
        return sum + line.quantity * l.price_per_unit;
      }, 0);

      const result = await applyTransition({
        tx,
        dealId: deal.id,
        requestId: request.id,
        currentStatus: deal.status,
        offerVersion: deal.offer_version,
        action: "send_final_offer",
        actor: { id: actor.id, role: "admin" },
        after: { final_offer_id: offer.id, version_no: offer.version_no, lines: body.lines },
        notificationPayload: {
          request_no: request.request_no,
          version_no: offer.version_no,
          lines: body.lines,
          total,
        },
      });

      return { result, offer, total };
    });

    return successResponse({
      request_id: request.id,
      final_offer_id: outcome.offer.id,
      version_no: outcome.offer.version_no,
      total: outcome.total,
      status: outcome.result.to,
    });
  },
);
