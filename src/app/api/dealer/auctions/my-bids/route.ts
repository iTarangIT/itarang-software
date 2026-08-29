/**
 * E-234 — GET /api/dealer/auctions/my-bids
 *
 * Every lot this dealer has bid on, with their best bid, the current standing
 * bid, and a resolved outcome: leading | outbid | won | lost.
 *
 * The outcome is computed server-side rather than left to the client, so the
 * grid, the detail page and the bell cannot end up disagreeing about what
 * "lost" means.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  auctionApiError,
  listDealerBids,
  requireAuctionDealer,
} from "@/lib/nbfc/auction/dealerView";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest) {
  try {
    const actor = await requireAuctionDealer();
    const items = await listDealerBids(actor.dealer_id);
    return NextResponse.json({ success: true, data: { items } });
  } catch (e) {
    const { body, status } = auctionApiError(e);
    return NextResponse.json(body, { status });
  }
}
