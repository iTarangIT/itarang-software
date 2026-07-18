/**
 * POST /api/payments/razorpay/buyback-link-webhook   (E-193/R5)
 *
 * Razorpay webhook for buyback vendor Payment Links — the signed SOURCE OF TRUTH
 * for a link's terminal state. `payment_link.paid` records the vendor receipt as a
 * settlement (through applyGatewayOutcome); `cancelled`/`expired` close the attempt
 * with no settlement.
 *
 * `payment_link.partially_paid` is an ANOMALY, not a happy path: accept_partial is
 * false on every link we create, so a partial payment should be impossible. We do
 * NOT record it as anything — we raise an admin portal alert and leave the attempt
 * in flight for a human. (This is the ONE place the webhook deliberately diverges
 * from the poller's mapPaymentLinkStatus, which treats partial as progress.)
 *
 * Same discipline as the payout webhook: nodejs, force-dynamic, raw body, ALWAYS
 * 200 once the signature passes, dark-ignore when no secret is set.
 *
 * Register in the Razorpay Dashboard → Webhooks for:
 *   payment_link.paid, payment_link.cancelled, payment_link.expired,
 *   payment_link.partially_paid.
 */

import { NextRequest, NextResponse } from "next/server";

import { db } from "@/lib/db";
import { buybackNotificationEvents } from "@/lib/db/schema";
import {
  adoptGatewayProviderRef,
  applyGatewayOutcome,
  dealRequestRef,
  findGatewayTxnByProviderRef,
  getGatewayTxn,
  mapPaymentLinkStatus,
} from "@/lib/buyback/gateway";
import { verifyWebhookSignature } from "@/lib/razorpay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Json = Record<string, unknown>;
const asObj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});
const asStr = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;
const asNum = (v: unknown): number =>
  typeof v === "number" ? v : Number(v) || 0;

/** UTR/RRN off a payment entity, if the acquirer supplied one. */
function extractUtr(payment: Json): string | null {
  const acq = asObj(payment.acquirer_data);
  const utr = acq.utr ?? acq.rrn;
  return typeof utr === "string" && utr ? utr : null;
}

let warnedMissingSecret = false;

export async function POST(req: NextRequest) {
  try {
    const body = await req.text();

    const secret =
      process.env.RAZORPAY_BUYBACK_LINK_WEBHOOK_SECRET || process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) {
      if (!warnedMissingSecret) {
        console.debug("[RZP buyback-link webhook] no webhook secret set — ignoring");
        warnedMissingSecret = true;
      }
      return NextResponse.json({ ignored: true });
    }

    const signature = req.headers.get("x-razorpay-signature");
    if (!signature) {
      return NextResponse.json({ error: "Missing signature" }, { status: 401 });
    }
    try {
      if (!verifyWebhookSignature(body, signature, secret)) {
        return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
      }
    } catch {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }

    // --- Signature has passed. From here every path returns 200. ---
    const event = JSON.parse(body) as Json;
    const payload = asObj(event.payload);
    const linkEntity = asObj(asObj(payload.payment_link).entity);
    const paymentEntity = asObj(asObj(payload.payment).entity);
    const linkId = asStr(linkEntity.id);
    const notes = asObj(linkEntity.notes);

    if (asStr(notes.itarang_purpose) !== "buyback_vendor_receipt") {
      return NextResponse.json({ ignored: true, reason: "not a buyback vendor receipt" });
    }

    // Correlate by the provider id, then by the gateway txn id in notes.
    let row = linkId ? await findGatewayTxnByProviderRef(linkId) : null;
    if (!row) {
      const fallbackId = asStr(notes.itarang_gateway_txn_id);
      if (fallbackId) {
        row = await getGatewayTxn(fallbackId);
        if (row && !row.provider_ref && linkId) {
          await adoptGatewayProviderRef(row.id, linkId);
        }
      }
    }
    if (!row) {
      console.warn(
        "[RZP buyback-link webhook] no gateway txn for link",
        linkId,
        asStr(notes.itarang_gateway_txn_id),
      );
      return NextResponse.json({ ignored: true, reason: "no matching attempt" });
    }

    const evt = asStr(event.event) ?? "";

    if (evt === "payment_link.paid") {
      // Amount + utr come from the PAYMENT, falling back to the link's amount_paid.
      const providerAmountPaise =
        asNum(paymentEntity.amount) || Number((linkEntity.amount_paid as number) ?? 0);
      const result = await applyGatewayOutcome(row.id, {
        type: "success",
        paymentId: asStr(paymentEntity.id),
        utr: extractUtr(paymentEntity),
        providerAmountPaise,
        raw: payload,
      });
      return NextResponse.json({ ok: true, applied: result.applied });
    }

    if (evt === "payment_link.cancelled" || evt === "payment_link.expired") {
      const status = evt === "payment_link.cancelled" ? "cancelled" : "expired";
      const outcome = mapPaymentLinkStatus(status, { raw: linkEntity });
      if (!outcome) return NextResponse.json({ ignored: true, reason: `unhandled ${evt}` });
      const result = await applyGatewayOutcome(row.id, outcome);
      return NextResponse.json({ ok: true, applied: result.applied });
    }

    if (evt === "payment_link.partially_paid") {
      // accept_partial is false — a partial payment is an anomaly. Do NOT record
      // any outcome; leave the attempt in flight and raise an admin portal alert.
      const ref = await dealRequestRef(row.deal_id);
      if (ref) {
        await db
          .insert(buybackNotificationEvents)
          .values({
            deal_id: row.deal_id,
            request_id: ref.request_id,
            event_type: "gateway_partial_payment",
            recipient_party: "ADMIN",
            channel: "PORTAL",
            idempotency_key: `${row.deal_id}:gateway_partial_payment:${row.id}`,
            payload: {
              kind: "gateway_alert",
              severity: "warning",
              message:
                `A PARTIAL payment arrived on the vendor payment link for deal ` +
                `${ref.request_no} — partial payments are disabled, so this needs manual review.`,
              gateway_txn_id: row.id,
              request_no: ref.request_no,
            } as never,
          })
          .onConflictDoNothing();
      }
      return NextResponse.json({ ok: true, applied: false, reason: "partial payment flagged" });
    }

    return NextResponse.json({ ignored: true, reason: `unhandled event ${evt}` });
  } catch (error) {
    console.error("[RZP buyback-link webhook] Error:", error);
    // 200 so Razorpay does not retry forever; the error is logged.
    return NextResponse.json({ status: "error_logged" }, { status: 200 });
  }
}
