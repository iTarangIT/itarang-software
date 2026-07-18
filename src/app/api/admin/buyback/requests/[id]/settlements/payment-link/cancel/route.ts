/**
 * POST /api/admin/buyback/requests/:id/settlements/payment-link/cancel  (E-193/R5)
 *
 * Cancel the in-flight vendor payment link on a deal. Cancelling is what frees the
 * VENDOR leg so a fresh link (or a manual settlement) can be recorded — the
 * one-in-flight-per-leg guard blocks both while a link is live.
 *
 * THE RACE THAT MATTERS: the vendor may pay in the seconds between the admin
 * deciding to cancel and Razorpay processing the cancel. So if the cancel is
 * refused, we re-fetch the link and, if it is already `paid`, record the SUCCESS
 * instead of leaving the money unrecorded — a paid link is a settlement, not a
 * cancellation.
 *
 * DARK UNLESS CONFIGURED: 409s before any provider work when links are off.
 */

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { loadAnyRequest, requireBuybackAdmin } from "@/lib/buyback/auth";
import { HttpError, NotFoundError } from "@/lib/buyback/errors";
import {
  applyGatewayOutcome,
  gatewayTxnView,
  gatewayTxnsForDeal,
  getGatewayTxn,
  INFLIGHT_STATUSES,
} from "@/lib/buyback/gateway";
import { dealHeader } from "@/lib/buyback/queries";
import {
  buybackLinksConfigured,
  cancelBuybackPaymentLink,
  fetchBuybackPaymentLink,
  razorpayErrorMessage,
} from "@/lib/razorpay";

export const runtime = "nodejs";

const INFLIGHT = new Set<string>(INFLIGHT_STATUSES);

/** UTR/RRN off a payment-link payment entity, if the acquirer supplied one. */
function extractUtr(payment: Record<string, unknown> | undefined): string | null {
  const acq = (payment?.acquirer_data ?? {}) as Record<string, unknown>;
  const utr = acq.utr ?? acq.rrn;
  return typeof utr === "string" && utr ? utr : null;
}

export const POST = withErrorHandler(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: requestId } = await ctx.params;
    await requireBuybackAdmin();

    if (!buybackLinksConfigured()) {
      throw new HttpError("Razorpay payment links are not configured.", 409);
    }

    const request = await loadAnyRequest(requestId);
    const header = await dealHeader(request.id);
    if (!header) throw new NotFoundError("Deal not found.");

    const txns = await gatewayTxnsForDeal(header.deal_id);
    const row = txns.find((t) => t.kind === "PAYMENT_LINK" && INFLIGHT.has(t.status));
    if (!row) throw new NotFoundError("There is no active payment link to cancel on this deal.");

    // Never reached the provider — just mark the local attempt cancelled.
    if (!row.provider_ref) {
      await applyGatewayOutcome(row.id, {
        type: "failure",
        status: "CANCELLED",
        reason: "cancelled by admin (link not yet created at provider)",
        raw: null,
      });
      const fresh = await getGatewayTxn(row.id);
      return successResponse({
        ok: true,
        cancelled: true,
        txn: fresh ? gatewayTxnView(fresh) : null,
      });
    }

    try {
      const cancelled = await cancelBuybackPaymentLink(row.provider_ref);
      await applyGatewayOutcome(row.id, {
        type: "failure",
        status: "CANCELLED",
        reason: "cancelled by admin",
        raw: cancelled.raw,
      });
      const fresh = await getGatewayTxn(row.id);
      return successResponse({
        ok: true,
        cancelled: true,
        txn: fresh ? gatewayTxnView(fresh) : null,
      });
    } catch (err) {
      // The cancel may have been refused because the link was already paid. Re-read
      // and, if so, record the settlement rather than swallow the payment.
      const link = await fetchBuybackPaymentLink(row.provider_ref).catch(() => null);
      if (link && link.status === "paid") {
        const raw = (link.raw ?? {}) as Record<string, unknown>;
        const amountPaidPaise = Number((raw.amount_paid as number | undefined) ?? 0);
        const paymentsArr =
          (link.payments as Array<Record<string, unknown>> | undefined) ??
          (raw.payments as Array<Record<string, unknown>> | undefined) ??
          [];
        const paid = paymentsArr.find((p) => p && (p.status === "captured" || p.payment_id));
        const paymentId = paid?.payment_id ? String(paid.payment_id) : null;
        await applyGatewayOutcome(row.id, {
          type: "success",
          paymentId,
          utr: extractUtr(paid),
          providerAmountPaise: amountPaidPaise,
          raw: link.raw,
        });
        const fresh = await getGatewayTxn(row.id);
        return successResponse({
          ok: true,
          cancelled: false,
          already_paid: true,
          message: "This link was already paid — recorded as settled.",
          txn: fresh ? gatewayTxnView(fresh) : null,
        });
      }
      throw new HttpError(razorpayErrorMessage(err), 502);
    }
  },
);
