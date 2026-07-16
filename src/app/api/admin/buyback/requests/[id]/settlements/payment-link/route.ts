/**
 * POST /api/admin/buyback/requests/:id/settlements/payment-link   (E-193/R5)
 *
 * Collect the VENDOR's leg of the money with a Razorpay Payment Link — the IN
 * mirror of the dealer payout route. The link's amount is Σ qty × vendor_price,
 * derived from deal_line_locks server side and NEVER taken from the client. When
 * the vendor pays, the signed webhook (or the poller) records it as a settlement
 * through the same applyGatewayOutcome core.
 *
 * DARK UNLESS CONFIGURED: with RAZORPAY_BUYBACK_LINKS_ENABLED unset (or the PG
 * keys absent) buybackLinksConfigured() is false and this 409s before any DB or
 * provider work. The vendor email carries NO dealer figures, margin, or floor —
 * only what the vendor owes and the link to pay it.
 */

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { buybackGatewayTransactions, buybackNotificationEvents } from "@/lib/db/schema";
import { loadAnyRequest, requireBuybackAdmin } from "@/lib/buyback/auth";
import { HttpError, NotFoundError, TransitionError, ValidationError } from "@/lib/buyback/errors";
import {
  applyGatewayOutcome,
  assertNoInflightGateway,
  attachProviderRef,
  gatewayTxnView,
  getGatewayTxn,
} from "@/lib/buyback/gateway";
import { dealMoney, legSubId, settlementsForDeal, vendorReceipt } from "@/lib/buyback/money";
import { loadAgreedVendorContact } from "@/lib/buyback/parties";
import { assertPayoutAllowed } from "@/lib/buyback/pickup";
import { dealHeader } from "@/lib/buyback/queries";
import { loadDealForUpdate, recordActivity } from "@/lib/buyback/transition";
import {
  buybackLinksConfigured,
  createBuybackPaymentLink,
  razorpayErrorMessage,
} from "@/lib/razorpay";

export const runtime = "nodejs";

/** A Postgres unique-violation (the gateway_txn_one_inflight_per_leg race). */
function isUniqueViolation(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { code?: string }).code === "23505");
}

export const POST = withErrorHandler(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: requestId } = await ctx.params;
    const actor = await requireBuybackAdmin();

    // Dark unless payment links are switched on — before any DB or provider work.
    if (!buybackLinksConfigured()) {
      throw new HttpError("Razorpay payment links are not configured.", 409);
    }

    const request = await loadAnyRequest(requestId);
    const header = await dealHeader(request.id);
    if (!header) throw new NotFoundError("Deal not found.");

    const vendor = await loadAgreedVendorContact(header.deal_id);
    if (!vendor) {
      throw new ValidationError("No agreed vendor on this deal, so a payment link cannot be raised.");
    }

    // --- Tx-1: mint the in-flight attempt. Server-derived amount; the partial
    //     unique index makes a double-clicked link a constraint error.
    let txn: { rowId: string; amount: number };
    try {
      txn = await db.transaction(async (tx) => {
        const deal = await loadDealForUpdate(tx, request.id);
        if (!deal) throw new NotFoundError("Deal not found.");
        if (deal.status !== "INVOICE_APPROVED") {
          throw new TransitionError(
            deal.status === "SETTLED" || deal.status === "CLOSED"
              ? "This deal is already settled."
              : `The deal is ${deal.status}. A payment link cannot start until the invoice is approved.`,
          );
        }

        // A no-op for the VENDOR leg (variance gates the dealer's payout only), but
        // called for symmetry with the manual/payout routes.
        await assertPayoutAllowed(deal.id, "VENDOR", tx);

        const subId = legSubId(request.request_no, "VENDOR");
        const existing = await settlementsForDeal(deal.id, tx);
        if (existing.some((s) => s.leg_sub_id === subId)) {
          throw new ValidationError(
            `${subId} is already recorded. A vendor receipt cannot be recorded twice.`,
          );
        }

        await assertNoInflightGateway(deal.id, "VENDOR", tx);

        const money = await dealMoney(deal.id, tx);
        const amount = vendorReceipt(money);
        if (amount === null || amount <= 0) {
          throw new ValidationError(
            "This deal has no agreed vendor price, so the receipt amount cannot be derived.",
          );
        }

        const [ins] = await tx
          .insert(buybackGatewayTransactions)
          .values({
            deal_id: deal.id,
            leg: "VENDOR",
            direction: "IN",
            kind: "PAYMENT_LINK",
            provider: "RAZORPAY",
            amount: amount.toString(),
            status: "INITIATED",
            initiated_by: actor.id,
          })
          .returning({ id: buybackGatewayTransactions.id });

        await recordActivity({
          tx,
          requestId: request.id,
          dealId: deal.id,
          actor: { id: actor.id, role: "admin" },
          action: "gateway_link_created",
          after: { gateway_txn_id: ins.id, amount, vendor: vendor.name },
        });

        return { rowId: ins.id, amount };
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new HttpError(
          "A payment link for this leg is already active. Cancel it before raising another.",
          409,
        );
      }
      throw err;
    }

    const { rowId, amount } = txn;

    const amountPaise = Math.round(amount * 100);
    if (amountPaise < 100) {
      await applyGatewayOutcome(rowId, {
        type: "failure",
        status: "FAILED",
        reason: "amount below the ₹1 Razorpay minimum",
        raw: null,
      });
      throw new ValidationError("The receipt amount is below the minimum Razorpay will accept.");
    }

    const notes: Record<string, string> = {
      itarang_purpose: "buyback_vendor_receipt",
      itarang_gateway_txn_id: rowId,
      deal_id: header.deal_id,
      request_no: request.request_no,
    };

    // --- Provider call (outside any transaction). A throw marks the attempt
    //     FAILED (retry is a fresh POST) and surfaces 502.
    let link;
    try {
      link = await createBuybackPaymentLink({
        amountPaise,
        referenceId: rowId,
        description: `Battery buyback ${request.request_no} — vendor payment`,
        customer: { name: vendor.name, email: vendor.email, contact: vendor.phone },
        expireBy: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
        notes,
      });
    } catch (err) {
      const message = razorpayErrorMessage(err);
      await applyGatewayOutcome(rowId, {
        type: "failure",
        status: "FAILED",
        reason: message,
        raw: null,
      });
      throw new HttpError(message, 502);
    }

    // Live link: stamp the plink id + short_url and move INITIATED → PENDING.
    await attachProviderRef(rowId, {
      providerRef: link.id,
      raw: link.raw,
      shortUrl: link.short_url,
      status: "PENDING",
    });

    // Deliver the link to the vendor via the dispatcher (not Razorpay's own mail —
    // notify is disabled on the link). Direct outbox insert, idempotent on the key,
    // so a re-raise cannot double-send. Skipped when the vendor has no email.
    if (vendor.email) {
      await db
        .insert(buybackNotificationEvents)
        .values({
          deal_id: header.deal_id,
          request_id: request.id,
          event_type: "payment_link_created",
          recipient_party: "VENDOR",
          channel: "EMAIL",
          recipient_ref: vendor.email,
          idempotency_key: `${header.deal_id}:payment_link_created:${rowId}`,
          payload: {
            kind: "vendor_payment_link",
            amount,
            short_url: link.short_url,
            request_no: request.request_no,
            vendor_name: vendor.name,
          } as never,
        })
        .onConflictDoNothing();
    }

    const fresh = await getGatewayTxn(rowId);
    return successResponse({
      ok: true,
      short_url: link.short_url,
      txn: fresh ? gatewayTxnView(fresh) : null,
    });
  },
);
