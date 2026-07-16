/**
 * POST /api/admin/buyback/requests/:id/settlements/gateway/:txnId/refresh (E-193/R6)
 *
 * Reconcile ONE gateway attempt against its provider on demand — the manual
 * counterpart to the poller, for an admin who does not want to wait for the next
 * tick. It fetches the payout / payment link from the provider, maps its status,
 * and applies the outcome through the same applyGatewayOutcome core (so a refresh
 * that lands on PROCESSED/PAID mints the settlement exactly as a webhook would).
 *
 * A terminal attempt is returned as-is with NO provider call. DARK UNLESS
 * CONFIGURED: a still-in-flight attempt whose provider is unconfigured 409s before
 * touching the provider.
 */

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { loadAnyRequest, requireBuybackAdmin } from "@/lib/buyback/auth";
import { HttpError, NotFoundError } from "@/lib/buyback/errors";
import {
  gatewayTxnView,
  getGatewayTxn,
  INFLIGHT_STATUSES,
  reconcileGatewayRow,
} from "@/lib/buyback/gateway";
import { dealHeader } from "@/lib/buyback/queries";
import { buybackLinksConfigured } from "@/lib/razorpay";
import { payoutsConfigured } from "@/lib/razorpayx";

export const runtime = "nodejs";

const INFLIGHT = new Set<string>(INFLIGHT_STATUSES);

export const POST = withErrorHandler(
  async (_req: Request, ctx: { params: Promise<{ id: string; txnId: string }> }) => {
    const { id: requestId, txnId } = await ctx.params;
    await requireBuybackAdmin();

    const request = await loadAnyRequest(requestId);
    const header = await dealHeader(request.id);
    if (!header) throw new NotFoundError("Deal not found.");

    // The attempt must belong to THIS deal — a 404 otherwise, never a leak that a
    // txn id exists on some other deal.
    const row = await getGatewayTxn(txnId);
    if (!row || row.deal_id !== header.deal_id) {
      throw new NotFoundError("Gateway transaction not found on this deal.");
    }

    // Terminal already — nothing to poll; return the current row untouched.
    if (!INFLIGHT.has(row.status)) {
      return successResponse({ ok: true, refreshed: false, txn: gatewayTxnView(row) });
    }

    // Dark unless the row's provider is configured — before any provider call.
    if (row.kind === "PAYOUT" && !payoutsConfigured()) {
      throw new HttpError("RazorpayX is not configured for payouts.", 409);
    }
    if (row.kind === "PAYMENT_LINK" && !buybackLinksConfigured()) {
      throw new HttpError("Razorpay payment links are not configured.", 409);
    }

    await reconcileGatewayRow(row);

    const fresh = await getGatewayTxn(txnId);
    return successResponse({ ok: true, refreshed: true, txn: gatewayTxnView(fresh ?? row) });
  },
);
