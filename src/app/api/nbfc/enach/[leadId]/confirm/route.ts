/**
 * POST /api/nbfc/enach/[leadId]/confirm
 *
 * Server-side confirmation of a managed (itarang_razorpay) E-NACH mandate right
 * after the customer authorises it in Razorpay Checkout. The browser posts the
 * Checkout handoff fields; the server VERIFIES the signature and FETCHES the
 * payment/token from Razorpay before flipping the canonical status to
 * `registered`. A mandate is never trusted on the client's word alone.
 *
 * This is what makes the flow complete on localhost (where Razorpay's webhook
 * cannot reach). In production the signature-verified webhook
 * (/api/payments/razorpay/emandate-webhook) remains the async source of truth;
 * both converge on identical row state and are idempotent.
 *
 * Role: `operations` or `nbfc_admin` (same as register, §7.2 / §9).
 */
import { NextRequest, NextResponse } from "next/server";
import { clientError } from "@/lib/nbfc/http-error";
import { z } from "zod";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { enachMandates } from "@/lib/db/schema";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { getWinningAssignment } from "@/lib/nbfc/enach";
import { fetchPayment, verifyPaymentSignature } from "@/lib/razorpay";
import { notifyEnachEvent } from "@/lib/notifications/events";
import { tenantDisplayName } from "@/lib/notifications/emit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  razorpay_payment_id: z.string().min(3).max(64),
  razorpay_order_id: z.string().min(3).max(64),
  razorpay_signature: z.string().min(3).max(256),
});

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

function asStr(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
  try {
    const { leadId } = await params;

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: invalid JSON" }, { status: 400 });
    }
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: "VALIDATION", issues: parsed.error.issues }, { status: 400 });
    }
    const { razorpay_payment_id, razorpay_order_id, razorpay_signature } = parsed.data;

    const actor = await resolveActor(req.headers);
    if (actor.role !== "operations" && actor.role !== "nbfc_admin") {
      return NextResponse.json(
        { ok: false, error: `FORBIDDEN: role '${actor.role}' cannot confirm E-NACH; operations or nbfc_admin required` },
        { status: 403 },
      );
    }

    // E-NACH is winner-only (§9.1); enforce tenant isolation.
    const winner = await getWinningAssignment(leadId);
    if (!winner || winner.tenant_id !== actor.tenant_id) {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: no winning NBFC for this lead under this tenant" },
        { status: 400 },
      );
    }

    // Verify the Checkout signature (HMAC of order_id|payment_id with key secret).
    if (!verifyPaymentSignature(razorpay_order_id, razorpay_payment_id, razorpay_signature)) {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: invalid Razorpay payment signature" },
        { status: 400 },
      );
    }

    // Locate the mandate row created at register time (by the Razorpay order id).
    const [row] = await db
      .select()
      .from(enachMandates)
      .where(eq(enachMandates.razorpay_order_id, razorpay_order_id))
      .limit(1);
    if (!row) {
      return NextResponse.json(
        { ok: false, error: "NOT_FOUND: no mandate for this Razorpay order" },
        { status: 404 },
      );
    }
    if (row.lead_id !== leadId || row.tenant_id !== actor.tenant_id) {
      return NextResponse.json(
        { ok: false, error: "FORBIDDEN: mandate does not belong to this lead/tenant" },
        { status: 403 },
      );
    }

    // Idempotent — once terminal, don't regress on a replayed confirm or a
    // confirm that races the webhook.
    if (row.status === "registered" || row.status === "failed") {
      return NextResponse.json({ ok: true, mandate_id: row.id, status: row.status, idempotent: true });
    }

    // Fetch the payment to read the registered token + bank details. The
    // recurring token IS the mandate; its id stands in for the UMRN until the
    // bank confirms one (the webhook later fills the real UMRN if different).
    const payment = await fetchPayment(razorpay_payment_id).catch(() => null);
    const tokenId = asStr(payment?.token_id);
    const failed = payment?.status === "failed";
    const now = new Date();

    if (failed) {
      await db
        .update(enachMandates)
        .set({
          status: "failed",
          provider_name: "razorpay",
          provider_raw_status: `payment.${asStr(payment?.status) ?? "failed"}`,
          provider_raw_payload: (payment ?? {}) as Record<string, unknown>,
          registration_method: "razorpay",
          razorpay_order_id,
          failure_reason: asStr(payment?.error_description) ?? "Razorpay authorisation failed",
          updated_at: now,
        })
        .where(eq(enachMandates.id, row.id));
      await notifyEnachEvent({
        leadId,
        event: "failed",
        nbfcName: await tenantDisplayName(actor.tenant_id),
        tenantId: actor.tenant_id,
        reason: asStr(payment?.error_description) ?? null,
      });
      return NextResponse.json({ ok: true, mandate_id: row.id, status: "failed" });
    }

    await db
      .update(enachMandates)
      .set({
        status: "registered",
        provider_name: "razorpay",
        provider_raw_status: `payment.${asStr(payment?.status) ?? "authorized"}`,
        provider_raw_payload: (payment ?? {}) as Record<string, unknown>,
        registration_method: "razorpay",
        razorpay_token_id: tokenId ?? row.razorpay_token_id,
        razorpay_order_id,
        umrn: tokenId ?? row.umrn,
        bank_name: asStr(payment?.bank) ?? row.bank_name,
        registered_at: now,
        updated_at: now,
      })
      .where(eq(enachMandates.id, row.id));

    await notifyEnachEvent({
      leadId,
      event: "confirmed",
      nbfcName: await tenantDisplayName(actor.tenant_id),
      tenantId: actor.tenant_id,
    });

    return NextResponse.json({ ok: true, mandate_id: row.id, status: "registered" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: statusFromError(msg) });
  }
}
