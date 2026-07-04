/**
 * POST /api/nbfc/settings/wallet/auto-recharge/confirm
 *
 * Server-side confirmation of the "iTarang Auto-Recharge Mandate" right after the
 * NBFC authorises it in Razorpay Checkout — mirrors the borrower E-NACH confirm
 * (/api/nbfc/enach/[leadId]/confirm). The browser posts the Checkout handoff
 * fields; the server VERIFIES the signature and FETCHES the registered token
 * before flipping auto_nach_status to `registered`. Makes the flow complete on
 * localhost where the webhook can't reach; the wallet webhook remains the async
 * source of truth in prod. Both converge, both idempotent. Role: nbfc_admin.
 */
import { NextRequest, NextResponse } from "next/server";
import { clientError } from "@/lib/nbfc/http-error";
import { z } from "zod";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { nbfcWallets } from "@/lib/db/schema";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { fetchPayment, verifyPaymentSignature } from "@/lib/razorpay";

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

export async function POST(req: NextRequest) {
  try {
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
    if (actor.role !== "nbfc_admin") {
      return NextResponse.json(
        { ok: false, error: `FORBIDDEN: nbfc_admin required (role '${actor.role}')` },
        { status: 403 },
      );
    }

    if (!verifyPaymentSignature(razorpay_order_id, razorpay_payment_id, razorpay_signature)) {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: invalid Razorpay payment signature" },
        { status: 400 },
      );
    }

    const [wallet] = await db
      .select()
      .from(nbfcWallets)
      .where(eq(nbfcWallets.tenant_id, actor.tenant_id))
      .limit(1);
    if (!wallet) {
      return NextResponse.json({ ok: false, error: "NOT_FOUND: no wallet" }, { status: 404 });
    }
    if (wallet.auto_nach_order_id !== razorpay_order_id) {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: order does not match this wallet's mandate" },
        { status: 400 },
      );
    }

    // Idempotent — once terminal, don't regress on a replay or a webhook race.
    if (wallet.auto_nach_status === "registered" || wallet.auto_nach_status === "failed") {
      return NextResponse.json({ ok: true, status: wallet.auto_nach_status, idempotent: true });
    }

    const payment = await fetchPayment(razorpay_payment_id).catch(() => null);
    const tokenId = asStr(payment?.token_id);
    const failed = payment?.status === "failed";
    const now = new Date();

    if (failed) {
      await db
        .update(nbfcWallets)
        .set({ auto_nach_status: "failed", provider_name: "razorpay", updated_at: now })
        .where(eq(nbfcWallets.id, wallet.id));
      return NextResponse.json({ ok: true, status: "failed" });
    }

    await db
      .update(nbfcWallets)
      .set({
        auto_nach_status: "registered",
        auto_nach_token_id: tokenId ?? wallet.auto_nach_token_id,
        provider_name: "razorpay",
        updated_at: now,
      })
      .where(eq(nbfcWallets.id, wallet.id));

    return NextResponse.json({ ok: true, status: "registered" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: statusFromError(msg) });
  }
}
