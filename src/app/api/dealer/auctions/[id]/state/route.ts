/**
 * E-234 — GET /api/dealer/auctions/[id]/state
 *
 * The 2-second poll payload for an open lot detail page: status, current bid,
 * bid count, deadline, whether the caller leads, and the minimum next bid.
 *
 * Deliberately tiny and identity-free. This repo has NO realtime substrate —
 * no WebSocket, no SSE, no supabase-realtime anywhere — so a live auction is
 * polled, which is also what the design document advises ("poll every few
 * seconds first; WebSockets only if the load actually shows up"). 2s matches
 * the fastest existing precedent in the codebase (the campaign banner).
 *
 * `ends_at` is in the payload because anti-snipe MOVES it: a client that cached
 * the deadline at page load would count down to the wrong second.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  auctionApiError,
  getLotLiveState,
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

    const state = await getLotLiveState(actor.dealer_id, id);
    if (!state) {
      return NextResponse.json(
        { success: false, error: { message: "Auction lot not found." } },
        { status: 404 },
      );
    }

    return NextResponse.json({ success: true, data: state });
  } catch (e) {
    const { body, status } = auctionApiError(e);
    return NextResponse.json(body, { status });
  }
}
