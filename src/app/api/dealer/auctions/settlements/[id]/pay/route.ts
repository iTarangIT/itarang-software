/**
 * POST   /api/dealer/auctions/settlements/[id]/pay      — open a payment
 * PATCH  /api/dealer/auctions/settlements/[id]/pay      — confirm one
 *
 * Two verbs on one path because they are two halves of a single act, and
 * splitting them across two routes buys nothing but a second copy of the
 * ownership check.
 *
 * The confirm verifies the Razorpay signature server-side. A captured payment
 * is never taken on the client's word — the same rule the e-mandate confirm
 * endpoint already follows.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  requireAuctionDealer,
  auctionApiError,
} from "@/lib/nbfc/auction/dealerView";
import {
  createPaymentIntent,
  confirmPayment,
} from "@/lib/nbfc/auction/purchases";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ConfirmBody = z
  .object({
    razorpay_order_id: z.string().min(1),
    razorpay_payment_id: z.string().min(1),
    razorpay_signature: z.string().min(1),
  })
  .strict();

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const actor = await requireAuctionDealer();
    const { id } = await ctx.params;
    const intent = await createPaymentIntent({
      dealer_id: actor.dealer_id,
      settlement_id: id,
    });
    return NextResponse.json({ success: true, data: intent });
  } catch (e) {
    const { body, status } = auctionApiError(e);
    return NextResponse.json(body, { status });
  }
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const actor = await requireAuctionDealer();
    const { id } = await ctx.params;

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json(
        { success: false, error: { message: "Invalid JSON." } },
        { status: 400 },
      );
    }

    const parsed = ConfirmBody.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        {
          success: false,
          error: { message: "Invalid payment confirmation." },
          issues: parsed.error.issues,
        },
        { status: 400 },
      );
    }

    const result = await confirmPayment({
      dealer_id: actor.dealer_id,
      settlement_id: id,
      ...parsed.data,
    });
    return NextResponse.json({ success: true, data: result });
  } catch (e) {
    const { body, status } = auctionApiError(e);
    return NextResponse.json(body, { status });
  }
}
