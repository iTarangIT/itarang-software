/**
 * GET  /api/buyback/requests/:id/invoice — what the dealer should bill (prefill)
 * POST /api/buyback/requests/:id/invoice — the dealer raises it (M12)
 *
 * PICKED_UP → INVOICE_RAISED. The dealer's leg of the money.
 *
 * The dealer supplies THEIR OWN invoice number. It is their legal document on
 * their own GST series, and issuing a number on someone else's series is not a
 * thing you may do. We store what they tell us. (iTarang's own series, INV-####-V,
 * is used only for the invoice WE issue to the vendor.)
 *
 * The line prices are prefilled from deal_line_locks and are NOT taken from the
 * request body. The dealer states a number, an attachment and nothing else about
 * money — what they are owed was settled when they accepted the final offer, and
 * it is read from the DB. Approval re-checks it anyway (M12 AC), so this is belt
 * and braces, but it means the common case cannot even go wrong.
 *
 * Dealer-scoped by loadOwnRequest: another dealer's request is a 404, never a 403.
 */

import { z } from "zod";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { invoiceLines, invoices } from "@/lib/db/schema";
import { loadOwnRequest, requireDealer } from "@/lib/buyback/auth";
import { NotFoundError, ValidationError } from "@/lib/buyback/errors";
import {
  dealMoney,
  dealerPayout,
  invoicesForDeal,
  settlementsForDeal,
  toLockedLines,
} from "@/lib/buyback/money";
import { dealHeader } from "@/lib/buyback/queries";
import { applyTransition, loadDealForUpdate } from "@/lib/buyback/transition";

export const runtime = "nodejs";

export const GET = withErrorHandler(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: requestId } = await ctx.params;
    const actor = await requireDealer();
    const request = await loadOwnRequest(actor, requestId);

    const header = await dealHeader(request.id);
    if (!header) throw new NotFoundError("Deal not found.");

    const money = await dealMoney(header.deal_id);
    const all = await invoicesForDeal(header.deal_id);

    // Only the dealer's own leg. The invoice iTarang issues to the vendor is
    // none of their business — it carries the vendor price, which is the margin
    // with one subtraction.
    const mine = all.filter((i) => i.leg === "DEALER");
    const returned = mine.find((i) => i.status === "RETURNED");
    const live = mine.find((i) => i.status !== "RETURNED");

    // Their own payout — TESTING_GUIDE Test 3: "the dealer can see … their own
    // payment". The vendor's receipt (leg=VENDOR) is never selected here.
    const payout = (await settlementsForDeal(header.deal_id)).find((s) => s.leg === "DEALER");

    return successResponse({
      request_id: request.id,
      request_no: request.request_no,
      status: header.status,
      can_raise: header.status === "PICKED_UP",

      // What to bill: per SKU, at the price they accepted. Mapped from
      // toLockedLines() — the dealer-safe projection (line_id/label/quantity/
      // dealer price ONLY) — so the raw money rows' vendor and margin fields
      // never enter this mapping's scope. Wire shape unchanged.
      lines: toLockedLines(money).map((l) => ({
        line_id: l.line_id,
        label: l.label,
        quantity: l.quantity,
        price_per_unit: Number(l.dealer_price),
        line_total: l.quantity * Number(l.dealer_price),
      })),
      invoice_total: dealerPayout(money),

      invoice: live
        ? { id: live.id, number: live.number, status: live.status, raised_at: live.created_at }
        : null,

      // If we sent one back, they need to know exactly why.
      returned: returned
        ? { number: returned.number, reason: returned.returned_reason }
        : null,

      payment: payout
        ? {
            amount: Number(payout.amount),
            txn_ref: payout.txn_ref,
            txn_date: payout.txn_date,
          }
        : null,
    });
  },
);

const bodySchema = z.object({
  /** The dealer's own invoice number, from their own GST series. */
  number: z.string().min(1).max(64),
  /** S3 key of their invoice PDF, uploaded via the presign route. */
  pdf_s3: z.string().min(1).optional(),
});

export const POST = withErrorHandler(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: requestId } = await ctx.params;
    const actor = await requireDealer();
    const request = await loadOwnRequest(actor, requestId);
    const body = bodySchema.parse(await req.json());

    const outcome = await db.transaction(async (tx) => {
      const deal = await loadDealForUpdate(tx, request.id);
      if (!deal) throw new NotFoundError("Deal not found.");

      const money = await dealMoney(deal.id, tx);
      if (money.length === 0) {
        throw new ValidationError("This deal has no locked prices to invoice against.");
      }

      const [invoice] = await tx
        .insert(invoices)
        .values({
          deal_id: deal.id,
          leg: "DEALER",
          raised_by_party: "DEALER",
          number: body.number,
          pdf_s3: body.pdf_s3 ?? null,
          status: "RAISED",
          raised_by: actor.id,
        })
        .returning({ id: invoices.id });

      // Itemized, from the LOCKS — not from the request body. A dealer cannot
      // bill a price they did not agree to, because they never get to state one.
      await tx.insert(invoiceLines).values(
        money.map((m) => ({
          invoice_id: invoice.id,
          line_id: m.line_id,
          quantity: m.quantity,
          price_per_unit: m.dealer_price.toString(),
          // Tax columns stay NULL — GST treatment is Chirag's open item (BRD §10).
        })),
      );

      const result = await applyTransition({
        tx,
        dealId: deal.id,
        requestId: request.id,
        currentStatus: deal.status,
        offerVersion: deal.offer_version,
        action: "raise_invoice",
        actor: { id: actor.id, role: "dealer" },
        after: {
          invoice_id: invoice.id,
          number: body.number,
          total: dealerPayout(money),
        },
        // A re-raise after a return happens at the same offer_version, so without
        // a discriminator the second invoice's event would collide with the
        // first's and nobody would be told the dealer had corrected it.
        eventDiscriminator: invoice.id,
        notificationPayload: {
          request_no: request.request_no,
          number: body.number,
          total: dealerPayout(money),
        },
      });

      return { invoiceId: invoice.id, status: result.to, total: dealerPayout(money) };
    });

    return successResponse(
      {
        request_id: request.id,
        invoice_id: outcome.invoiceId,
        status: outcome.status,
        total: outcome.total,
      },
      201,
    );
  },
);
