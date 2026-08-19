/**
 * GET /api/dealer/auctions/settlements
 *
 * What this dealer has won, and where each purchase has got to.
 *
 * There was no dealer-side settlement endpoint at all: `listSettlements()`
 * filters on `seller_tenant_id`, so the buyer could not see their own purchase.
 * "My bids" ended at the word "won" and the trail went cold.
 */
import { NextResponse } from "next/server";
import {
  requireAuctionDealer,
  auctionApiError,
} from "@/lib/nbfc/auction/dealerView";
import { listDealerPurchases } from "@/lib/nbfc/auction/purchases";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const actor = await requireAuctionDealer();
    const items = await listDealerPurchases(actor.dealer_id);
    return NextResponse.json({ success: true, data: { items } });
  } catch (e) {
    const { body, status } = auctionApiError(e);
    return NextResponse.json(body, { status });
  }
}
