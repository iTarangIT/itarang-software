/**
 * POST /api/admin/buyback/requests/:id/margin
 *
 * Per-line margin (BRD M08). DEALER_ACCEPTED → MARGIN_SET.
 *
 * This is where deal_line_locks is written — the immutable per-SKU snapshot every
 * document and report reads from afterwards. Two properties matter:
 *
 *  · The dealer price is copied from the ACCEPTED final offer, server-side. The
 *    client does not get to state it, so the locked price cannot drift from what
 *    the dealer actually agreed to.
 *  · Margin may be entered as a flat ₹/unit or a %, but only the RESOLVED RUPEE
 *    figure is stored. Reports never re-derive a percentage against a price that
 *    may since have moved.
 *
 * A reopen bumps offer_version and this route runs again, INSERTing a new lock
 * generation. Locks are never UPDATEd.
 */

import { z } from "zod";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { buybackDeals, dealLineLocks } from "@/lib/db/schema";
import { loadAnyRequest, requireBuybackAdmin } from "@/lib/buyback/auth";
import { NotFoundError, ValidationError } from "@/lib/buyback/errors";
import { resolveDealerPrice } from "@/lib/buyback/floor";
import { linesForRequest } from "@/lib/buyback/queries";
import { applyTransition, loadDealForUpdate } from "@/lib/buyback/transition";
import { eq } from "drizzle-orm";

export const runtime = "nodejs";

const bodySchema = z.object({
  margin_mode: z.enum(["FLAT", "PCT"]),
  lines: z
    .array(
      z.object({
        line_id: z.string().uuid(),
        /** ₹/unit when FLAT; a percentage of the dealer price when PCT. */
        margin: z.number().nonnegative(),
      }),
    )
    .min(1),
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

      const lines = await linesForRequest(request.id, tx);
      const byId = new Map(lines.map((l) => [l.id, l]));

      if (body.lines.length !== lines.length) {
        throw new ValidationError(
          `Margin must be set on every battery line. This request has ${lines.length}; you sent ${body.lines.length}.`,
        );
      }

      const locks = body.lines.map((entry) => {
        const line = byId.get(entry.line_id);
        if (!line) {
          throw new ValidationError("A margin line does not belong to this request.");
        }

        // The dealer's accepted price — read from the DB, never from the client,
        // and validated by resolveDealerPrice rather than inline.
        //
        // This was `if (!Number.isFinite(Number(line.dealer_price)))`, which
        // reads as a null-guard and is not one: Number(null) is 0 and
        // isFinite(0) is true, so an UNPRICED line passed straight through and
        // got locked at ₹0 in deal_line_locks — INSERT-only, fill-once, so the
        // dealer's price for that deal was permanently zero and the floor
        // collapsed to margin alone. Reachable today via the review-bar `accept`
        // (SUBMITTED/UNDER_REVIEW → DEALER_ACCEPTED), which prices nothing.
        // db-1 has no ₹0 locks only because every acceptance so far went via
        // dealer_accept, whose final-offer route refuses to send unless every
        // line is priced. Luck, not design.
        const resolved = resolveDealerPrice(line.dealer_price);
        if (!resolved.ok) {
          throw new ValidationError(
            resolved.reason === "missing"
              ? `No accepted price for ${line.variant_type}. The dealer must accept a final offer before margin can be locked.`
              : `The accepted price for ${line.variant_type} is not a usable figure (${resolved.raw}). Margin cannot be locked against it.`,
          );
        }
        const dealerPrice = resolved.price;

        // Resolve to whole rupees per unit, once, here.
        const marginValue =
          body.margin_mode === "FLAT"
            ? Math.round(entry.margin)
            : Math.round((dealerPrice * entry.margin) / 100);

        return {
          deal_id: deal.id,
          line_id: line.id,
          offer_version: deal.offer_version,
          dealer_price: dealerPrice.toString(),
          margin_value: marginValue.toString(),
          margin_mode: body.margin_mode,
          // What we will ask the vendor. Vendor price is filled on the sell side.
          vendor_ask: (dealerPrice + marginValue).toString(),
          locked_by: actor.id,
          quantity: line.quantity,
        };
      });

      // Immutable: INSERT only. The UNIQUE(deal, line, offer_version) index means
      // a double-submit at the same version is refused by the DB, not by luck.
      // `quantity` rides along on each entry for the floor arithmetic below, but
      // it is not a column on deal_line_locks — strip it before the insert.
      await tx.insert(dealLineLocks).values(
        locks.map((lock) => ({
          deal_id: lock.deal_id,
          line_id: lock.line_id,
          offer_version: lock.offer_version,
          dealer_price: lock.dealer_price,
          margin_value: lock.margin_value,
          margin_mode: lock.margin_mode,
          vendor_ask: lock.vendor_ask,
          locked_by: lock.locked_by,
        })),
      );

      // The floor: what iTarang must clear on the vendor leg to break even. It
      // blocks below-floor routing in Sprint 2 (M08/M10).
      const floorTotal = locks.reduce(
        (sum, l) => sum + l.quantity * (Number(l.dealer_price) + Number(l.margin_value)),
        0,
      );

      await tx
        .update(buybackDeals)
        .set({ floor_total: floorTotal.toString() })
        .where(eq(buybackDeals.id, deal.id));

      const result = await applyTransition({
        tx,
        dealId: deal.id,
        requestId: request.id,
        currentStatus: deal.status,
        offerVersion: deal.offer_version,
        action: "set_margin",
        actor: { id: actor.id, role: "admin" },
        after: {
          margin_mode: body.margin_mode,
          floor_total: floorTotal,
          locks: locks.map((l) => ({
            line_id: l.line_id,
            dealer_price: Number(l.dealer_price),
            margin_value: Number(l.margin_value),
            vendor_ask: Number(l.vendor_ask),
          })),
        },
        // set_margin notifies ADMIN on PORTAL, never the dealer — they must not
        // learn that a margin exists, let alone what it is (M08 AC).
        notificationPayload: { request_no: request.request_no, floor_total: floorTotal },
      });

      return { result, floorTotal, locks };
    });

    return successResponse({
      request_id: request.id,
      status: outcome.result.to,
      floor_total: outcome.floorTotal,
      locked_lines: outcome.locks.length,
    });
  },
);
