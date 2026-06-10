/**
 * POST /api/payments/razorpay/wallet-webhook
 *
 * Inflow webhook for the NBFC prepaid wallet (BRD Addendum V0.3.1 §16.4 capability
 * 2). The signature-verified SOURCE OF TRUTH for money landing in a wallet:
 *   • `virtual_account.credited` / `payment.captured` → idempotent wallet credit
 *     (manual UPI/NEFT top-up AND the auto-recharge debit settlement).
 *   • `token.confirmed` / `token.rejected|cancelled|paused` → flip the wallet's
 *     auto-recharge mandate status (the async confirmation of §16.4 capability 3).
 *
 * Provider-agnostic: parsing is delegated to the active WalletFundsProvider; the
 * credit is posted by the vendor-neutral `creditInflow` (idempotent on
 * provider_event_id, §16.3). Always 200 on a handled/logged event so the provider
 * does not retry endlessly.
 *
 * Register this URL in the Razorpay Dashboard → Webhooks for events:
 *   virtual_account.credited, payment.captured,
 *   token.confirmed, token.rejected, token.cancelled, token.paused.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq, or } from "drizzle-orm";

import { db } from "@/lib/db";
import { nbfcWallets } from "@/lib/db/schema";
import { creditInflow } from "@/lib/nbfc/charging";
import { verifyWebhookSignature } from "@/lib/razorpay";
import { getWalletFundsProvider } from "@/lib/nbfc/wallet/provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Json = Record<string, unknown>;
const asObj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});
const asStr = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Map a Razorpay token event → the wallet's auto-recharge mandate status. */
function mandateStatusFromEvent(event: string): "registered" | "failed" | null {
  switch (event) {
    case "token.confirmed":
      return "registered";
    case "token.rejected":
    case "token.cancelled":
    case "token.paused":
      return "failed";
    default:
      return null;
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.text();
    const signature = req.headers.get("x-razorpay-signature");
    if (!signature) {
      return NextResponse.json({ error: "Missing signature" }, { status: 400 });
    }

    // ── Auto-recharge mandate token events: correlate by stored order/customer ──
    // (Verified here directly; the funds provider handles inflow events.)
    let event: Json | null = null;
    try {
      event = JSON.parse(body) as Json;
    } catch {
      event = null;
    }
    const eventName = event ? asStr(event.event) ?? "" : "";
    const mandateStatus = mandateStatusFromEvent(eventName);
    if (mandateStatus) {
      try {
        if (!verifyWebhookSignature(body, signature)) {
          return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
        }
      } catch {
        return NextResponse.json({ error: "Signature verification failed" }, { status: 401 });
      }
      const payload = asObj((event as Json).payload);
      const tokenEntity = asObj(asObj(payload.token).entity);
      const orderEntity = asObj(asObj(payload.order).entity);
      const notes = { ...asObj(orderEntity.notes), ...asObj(tokenEntity.notes) };
      // Only act on wallet auto-recharge mandates (not borrower E-NACH ones).
      if (asStr(notes.itarang_purpose) !== "wallet_auto_recharge") {
        return NextResponse.json({ status: "ignored", reason: "not a wallet mandate" });
      }
      const orderId = asStr(orderEntity.id) ?? asStr(tokenEntity.order_id);
      const tokenId = asStr(tokenEntity.id);
      const tenantId = asStr(notes.itarang_tenant_id);
      const [wallet] = await db
        .select()
        .from(nbfcWallets)
        .where(
          orderId && tenantId
            ? or(eq(nbfcWallets.auto_nach_order_id, orderId), eq(nbfcWallets.tenant_id, tenantId))!
            : orderId
              ? eq(nbfcWallets.auto_nach_order_id, orderId)
              : eq(nbfcWallets.tenant_id, tenantId ?? "00000000-0000-0000-0000-000000000000"),
        )
        .limit(1);
      if (!wallet) {
        return NextResponse.json({ status: "ignored", reason: "no matching wallet" });
      }
      if (wallet.auto_nach_status === "registered" && mandateStatus === "registered") {
        return NextResponse.json({ status: "already_processed" });
      }
      await db
        .update(nbfcWallets)
        .set({
          auto_nach_status: mandateStatus,
          auto_nach_token_id: tokenId ?? wallet.auto_nach_token_id,
          auto_nach_order_id: orderId ?? wallet.auto_nach_order_id,
          provider_name: "razorpay",
          updated_at: new Date(),
        })
        .where(eq(nbfcWallets.id, wallet.id));
      return NextResponse.json({ status: "ok", mandate: mandateStatus });
    }

    // ── Inflow (top-up) events: delegate parsing to the funds provider ──────────
    const provider = await getWalletFundsProvider();
    const headers: Record<string, string> = { "x-razorpay-signature": signature };
    const result = await provider.parseInflowWebhook(body, headers);
    if (!result.ok) {
      if (result.reason === "bad_signature") {
        return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
      }
      return NextResponse.json({ status: "ignored", reason: result.reason, detail: result.detail });
    }

    const inflow = result.event;
    const credit = await creditInflow({
      tenantId: inflow.tenantId,
      nbfcId: inflow.nbfcId,
      providerName: provider.providerId,
      providerEventId: inflow.providerEventId,
      amount: inflow.amount / 100, // paise → rupees
      rawStatus: inflow.rawStatus,
      raw: inflow.raw,
    });

    return NextResponse.json({
      status: "ok",
      credited: credit.credited,
      idempotent: credit.idempotent,
    });
  } catch (error) {
    console.error("[RZP wallet webhook] Error:", error);
    // 200 so Razorpay does not retry forever; the error is logged.
    return NextResponse.json({ status: "error_logged" }, { status: 200 });
  }
}
