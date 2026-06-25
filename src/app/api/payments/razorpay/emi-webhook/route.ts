/**
 * POST /api/payments/razorpay/emi-webhook
 *
 * Razorpay webhook for automated EMI auto-debits (the LIVE path of
 * /api/cron/nbfc/run-emi-autodebit). SOURCE OF TRUTH for whether a debited EMI
 * actually settled — the cron only SUBMITS the debit; this marks it paid/failed.
 *
 * Signature-verified (HMAC-SHA256, x-razorpay-signature). Acts ONLY on events
 * whose payment notes carry `purpose='emi_debit'` so it never collides with the
 * e-mandate webhook (which shares the same payment.* event stream).
 *
 * Register this URL in Razorpay Dashboard → Webhooks for:
 *   payment.captured, payment.authorized, payment.failed.
 * Requires RAZORPAY_WEBHOOK_SECRET.
 *
 * Always returns 200 once handled/logged so Razorpay does not retry endlessly.
 */
import { NextRequest, NextResponse } from "next/server";
import { desc, eq, or } from "drizzle-orm";

import { db } from "@/lib/db";
import { emiPaymentAttempts, emiSchedules } from "@/lib/db/schema";
import { verifyWebhookSignature } from "@/lib/razorpay";
import { applyEmiPayment } from "@/lib/nbfc/servicing/applyEmiPayment";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Json = Record<string, unknown>;

function asObj(v: unknown): Json {
  return v && typeof v === "object" ? (v as Json) : {};
}
function asStr(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** 'success' | 'failed' | null (ignore). */
function classify(event: string): "success" | "failed" | null {
  switch (event) {
    case "payment.captured":
    case "payment.authorized":
      return "success";
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
        console.error("[RZP emi webhook] Invalid signature");
        return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
      }
    } catch {
      return NextResponse.json({ error: "Signature verification failed" }, { status: 401 });
    }

    const event = JSON.parse(body) as Json;
    const eventName = asStr(event.event) ?? "";
    const kind = classify(eventName);
    if (!kind) {
      return NextResponse.json({ status: "ignored", event: eventName });
    }

    const paymentEntity = asObj(asObj(asObj(event.payload).payment).entity);
    const notes = asObj(paymentEntity.notes);

    // Scope guard — only EMI debits, so we don't clash with the e-mandate webhook.
    if (asStr(notes.purpose) !== "emi_debit") {
      return NextResponse.json({ status: "ignored", reason: "not an emi_debit" });
    }

    const emiScheduleId = asStr(notes.emi_schedule_id);
    const paymentId = asStr(paymentEntity.id);
    const orderId = asStr(paymentEntity.order_id);

    // Resolve the target EMI: prefer the note, else correlate via the attempt.
    let targetEmiId = emiScheduleId;
    let attemptId: string | null = null;
    if (!targetEmiId && (paymentId || orderId)) {
      const [att] = await db
        .select({ id: emiPaymentAttempts.id, emi: emiPaymentAttempts.emi_schedule_id })
        .from(emiPaymentAttempts)
        .where(
          paymentId && orderId
            ? or(
                eq(emiPaymentAttempts.razorpay_payment_id, paymentId),
                eq(emiPaymentAttempts.razorpay_order_id, orderId),
              )!
            : paymentId
              ? eq(emiPaymentAttempts.razorpay_payment_id, paymentId)
              : eq(emiPaymentAttempts.razorpay_order_id, orderId as string),
        )
        .limit(1);
      if (att) {
        targetEmiId = att.emi;
        attemptId = att.id;
      }
    }

    if (!targetEmiId) {
      console.warn("[RZP emi webhook] No correlation to an EMI", { paymentId, orderId });
      return NextResponse.json({ status: "ignored", reason: "no correlation key" });
    }

    // Find the attempt row to update (latest for this EMI if not already found).
    if (!attemptId) {
      const [att] = await db
        .select({ id: emiPaymentAttempts.id })
        .from(emiPaymentAttempts)
        .where(eq(emiPaymentAttempts.emi_schedule_id, targetEmiId))
        .orderBy(desc(emiPaymentAttempts.created_at))
        .limit(1);
      attemptId = att?.id ?? null;
    }

    const now = new Date();

    if (kind === "failed") {
      const reason =
        asStr(paymentEntity.error_description) ?? `Razorpay event ${eventName}`;
      if (attemptId) {
        await db
          .update(emiPaymentAttempts)
          .set({
            status: "failed",
            failure_reason: reason,
            razorpay_payment_id: paymentId ?? undefined,
            provider_raw_status: eventName,
            provider_raw_payload: event as unknown as Json,
            updated_at: now,
          })
          .where(eq(emiPaymentAttempts.id, attemptId));
      }
      // Leave the EMI overdue so the next cron re-picks it.
      return NextResponse.json({ status: "ok", outcome: "failed", emi_id: targetEmiId });
    }

    // Success — terminal guard against replays.
    const [emi] = await db
      .select({ status: emiSchedules.status })
      .from(emiSchedules)
      .where(eq(emiSchedules.id, targetEmiId))
      .limit(1);
    if (!emi) {
      return NextResponse.json({ status: "ignored", reason: "emi not found" });
    }
    if (emi.status === "paid" || emi.status === "paid_late") {
      return NextResponse.json({ status: "already_processed", emi_id: targetEmiId });
    }

    const result = await db.transaction((tx) =>
      applyEmiPayment(tx, {
        emiId: targetEmiId as string,
        paymentRef: paymentId,
        paidAt: now,
        mode: "live",
        channel: "enach",
      }),
    );

    if (attemptId) {
      await db
        .update(emiPaymentAttempts)
        .set({
          status: "succeeded",
          razorpay_payment_id: paymentId ?? undefined,
          provider_raw_status: eventName,
          provider_raw_payload: event as unknown as Json,
          updated_at: now,
        })
        .where(eq(emiPaymentAttempts.id, attemptId));
    }

    return NextResponse.json({
      status: "ok",
      outcome: "paid",
      emi_id: targetEmiId,
      emi_status: result.status,
      loan_closed: result.loanClosed ?? false,
    });
  } catch (error) {
    console.error("[RZP emi webhook] Error:", error);
    // 200 so Razorpay does not retry forever; the error is logged.
    return NextResponse.json({ status: "error_logged" }, { status: 200 });
  }
}
