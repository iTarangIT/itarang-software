/**
 * E-234 — POST | DELETE /api/dealer/auctions/[id]/auto-bid
 *
 * A dealer's standing maximum. The engine that acts on it lives in
 * src/lib/nbfc/auction/autoBid.ts and runs inside placeBid()'s locked
 * transaction — before E-234 this control was stored, shown back to the bidder,
 * and never acted on by anything.
 *
 * The maximum is keyed on `bidder_dealer_id`, not on tenant: after the E-232
 * re-point every dealer bidding on a lot writes the SELLER's tenant, so a
 * tenant-keyed standing order would let one dealer overwrite another's.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { eq } from "drizzle-orm";
import { auctionLots } from "@/lib/db/schema";
import {
  auctionApiError,
  assertDealerMayBid,
  requireAuctionDealer,
} from "@/lib/nbfc/auction/dealerView";
import { setAutoBid, cancelAutoBid } from "@/lib/nbfc/auction/autoBid";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ max_amount: z.number().positive() }).strict();

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const actor = await requireAuctionDealer();
    const { id } = await ctx.params;

    let raw: unknown;
    try {
      const text = await req.text();
      raw = text ? JSON.parse(text) : {};
    } catch {
      return NextResponse.json(
        { success: false, error: { message: "Invalid JSON." } },
        { status: 400 },
      );
    }
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: { message: "max_amount must be a positive number." } },
        { status: 400 },
      );
    }

    await assertDealerMayBid(actor.dealer_id, id);

    const [lot] = await db
      .select({
        status: auctionLots.status,
        base_price: auctionLots.base_price,
        seller_tenant_id: auctionLots.seller_tenant_id,
      })
      .from(auctionLots)
      .where(eq(auctionLots.id, id))
      .limit(1);

    if (!lot) throw new Error("NOT_FOUND: auction lot not found");
    if (lot.status !== "live") {
      throw new Error(`CONFLICT: this auction is ${lot.status}, not live`);
    }
    // A ceiling below the opening price can never fire, so accepting it would
    // be storing a control that silently does nothing — the exact failure this
    // whole feature exists to end.
    if (parsed.data.max_amount < Number(lot.base_price)) {
      throw new Error(
        `BAD_REQUEST: your maximum must be at least the opening price of ₹${Number(lot.base_price).toLocaleString("en-IN")}`,
      );
    }
    if (!lot.seller_tenant_id) {
      throw new Error("CONFLICT: this lot has no seller and cannot take bids");
    }

    const result = await setAutoBid({
      lot_id: id,
      tenant_id: lot.seller_tenant_id,
      bidder_dealer_id: actor.dealer_id,
      max_amount: parsed.data.max_amount,
    });

    return NextResponse.json({ success: true, data: result });
  } catch (e) {
    const { body, status } = auctionApiError(e);
    return NextResponse.json(body, { status });
  }
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const actor = await requireAuctionDealer();
    const { id } = await ctx.params;

    const [lot] = await db
      .select({ seller_tenant_id: auctionLots.seller_tenant_id })
      .from(auctionLots)
      .where(eq(auctionLots.id, id))
      .limit(1);

    const result = await cancelAutoBid({
      lot_id: id,
      tenant_id: lot?.seller_tenant_id ?? "",
      bidder_dealer_id: actor.dealer_id,
    });

    return NextResponse.json({ success: true, data: result });
  } catch (e) {
    const { body, status } = auctionApiError(e);
    return NextResponse.json(body, { status });
  }
}
