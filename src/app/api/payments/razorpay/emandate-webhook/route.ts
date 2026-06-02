/**
 * POST /api/payments/razorpay/emandate-webhook
 *
 * Razorpay webhook for the "iTarang Razorpay (managed)" E-NACH variant (E-145 /
 * BRD Addendum V0.2 §9). This is the SOURCE OF TRUTH for the managed mandate's
 * canonical status — the client checkout `handler` only refreshes the view.
 *
 * Signature-verified (HMAC-SHA256, x-razorpay-signature) via the same util the
 * QR webhook uses. Maps Razorpay token/order/payment events into iTarang's
 * canonical E-NACH states (§9.3); provider raw payload is retained for audit.
 *
 * Register this URL in the Razorpay Dashboard → Webhooks for the events:
 *   token.confirmed, token.rejected, token.cancelled, token.paused,
 *   order.paid, payment.authorized, payment.failed.
 *
 * Always returns 200 once handled/logged so Razorpay does not retry endlessly.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq, or } from "drizzle-orm";

import { db } from "@/lib/db";
import { enachMandates } from "@/lib/db/schema";
import { verifyWebhookSignature } from "@/lib/razorpay";
import type { EnachState } from "@/lib/nbfc/enach";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Json = Record<string, unknown>;

function asObj(v: unknown): Json {
  return v && typeof v === "object" ? (v as Json) : {};
}
function asStr(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Map a Razorpay event name to a canonical E-NACH state (or null = ignore). */
function mapEvent(event: string): EnachState | null {
  switch (event) {
    case "token.confirmed":
    case "order.paid":
    case "payment.authorized":
      return "registered";
    case "token.rejected":
    case "token.cancelled":
    case "token.paused":
    case "payment.failed":
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
    try {
      if (!verifyWebhookSignature(body, signature)) {
        console.error("[RZP e-mandate webhook] Invalid signature");
        return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
      }
    } catch {
      console.error("[RZP e-mandate webhook] Signature verification failed");
      return NextResponse.json({ error: "Signature verification failed" }, { status: 401 });
    }

    const event = JSON.parse(body) as Json;
    const eventName = asStr(event.event) ?? "";
    const next = mapEvent(eventName);
    if (!next) {
      return NextResponse.json({ status: "ignored", event: eventName });
    }

    const payload = asObj(event.payload);
    const tokenEntity = asObj(asObj(payload.token).entity);
    const orderEntity = asObj(asObj(payload.order).entity);
    const paymentEntity = asObj(asObj(payload.payment).entity);

    // Correlate: prefer our enach_ref from notes (set at order creation), else
    // fall back to the Razorpay order id we stored on the mandate row.
    const notes = {
      ...asObj(orderEntity.notes),
      ...asObj(paymentEntity.notes),
      ...asObj(tokenEntity.notes),
    };
    const enachRef = asStr(notes.itarang_enach_ref);
    const orderId =
      asStr(orderEntity.id) ?? asStr(paymentEntity.order_id) ?? null;

    if (!enachRef && !orderId) {
      console.warn("[RZP e-mandate webhook] No correlation ref/order id", eventName);
      return NextResponse.json({ status: "ignored", reason: "no correlation key" });
    }

    const [row] = await db
      .select()
      .from(enachMandates)
      .where(
        enachRef && orderId
          ? or(eq(enachMandates.enach_ref, enachRef), eq(enachMandates.razorpay_order_id, orderId))!
          : enachRef
            ? eq(enachMandates.enach_ref, enachRef)
            : eq(enachMandates.razorpay_order_id, orderId as string),
      )
      .limit(1);

    if (!row) {
      console.warn("[RZP e-mandate webhook] No mandate for", { enachRef, orderId });
      return NextResponse.json({ status: "ignored", reason: "no matching mandate" });
    }

    // Idempotency — once terminal, don't regress on replays/late events.
    if (row.status === "registered" || row.status === "failed") {
      return NextResponse.json({ status: "already_processed", mandate_status: row.status });
    }

    const bank = asObj(tokenEntity.bank_details);
    const now = new Date();
    const failureReason =
      next === "failed"
        ? asStr(asObj(paymentEntity.error_description).toString?.()) ??
          asStr(paymentEntity.error_description) ??
          asStr(tokenEntity.error_description) ??
          `Razorpay event ${eventName}`
        : row.failure_reason;

    await db
      .update(enachMandates)
      .set({
        status: next,
        provider_name: "razorpay",
        provider_raw_status: eventName,
        provider_raw_payload: event as unknown as Json,
        registration_method: "razorpay",
        razorpay_token_id: asStr(tokenEntity.id) ?? row.razorpay_token_id,
        razorpay_order_id: orderId ?? row.razorpay_order_id,
        umrn: asStr(bank.umrn) ?? asStr(tokenEntity.id) ?? row.umrn,
        bank_name: asStr(bank.bank_name) ?? row.bank_name,
        account_masked: asStr(bank.account_number) ?? asStr(bank.beneficiary_account) ?? row.account_masked,
        registered_at: next === "registered" ? now : row.registered_at,
        failure_reason: failureReason,
        updated_at: now,
      })
      .where(eq(enachMandates.id, row.id));

    return NextResponse.json({ status: "ok", mandate_id: row.id, mapped: next });
  } catch (error) {
    console.error("[RZP e-mandate webhook] Error:", error);
    // 200 so Razorpay does not retry forever; the error is logged.
    return NextResponse.json({ status: "error_logged" }, { status: 200 });
  }
}
