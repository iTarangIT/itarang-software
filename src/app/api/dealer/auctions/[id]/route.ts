/**
 * E-234 — GET /api/dealer/auctions/[id]
 *
 * Full lot detail for a dealer: photos, per-item condition and SOH, quantity,
 * location, the current highest bid and the bid history.
 *
 * The bid history carries AMOUNTS AND TIMES ONLY. Whose bid it was never enters
 * the payload (BRD §11) — only `is_yours`, computed server-side from the
 * caller's own account, so the client never holds an identity it should not.
 *
 * A dealer outside this lot's frozen audience gets 404, not 403: they should
 * not be able to learn the lot exists.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  auctionApiError,
  getDealerLotDetail,
  requireAuctionDealer,
} from "@/lib/nbfc/auction/dealerView";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const actor = await requireAuctionDealer();
    const { id } = await ctx.params;

    const lot = await getDealerLotDetail(actor.dealer_id, id);
    if (!lot) {
      return NextResponse.json(
        { success: false, error: { message: "Auction lot not found." } },
        { status: 404 },
      );
    }

    return NextResponse.json({ success: true, data: lot });
  } catch (e) {
    const { body, status } = auctionApiError(e);
    return NextResponse.json(body, { status });
  }
}
