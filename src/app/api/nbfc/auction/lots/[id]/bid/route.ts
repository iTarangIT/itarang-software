/**
 * POST /api/nbfc/auction/lots/[id]/bid — CLOSED as of E-232.
 *
 * E-038 built this route on the premise that NBFCs bid against each other for
 * recovered stock. The Battery Auction BRD §9 states the opposite: **dealers
 * are the only bidders, and a lot must never be visible to another NBFC**. So
 * this is not a route that needs new permissions — it is a route whose entire
 * premise was withdrawn.
 *
 * It returns 403 rather than being deleted, deliberately. A 404 on a path that
 * shipped and worked reads as a broken deploy and sends whoever hits it into
 * the router and the build logs; a 403 that names the rule and the replacement
 * answers the question where it is asked. The dealer path is
 * POST /api/dealer/auctions/[id]/bid.
 *
 * The bidding logic itself was NOT deleted with the route — `placeBid()` in
 * src/lib/nbfc/auction/service.ts is intact, now transactional and row-locked,
 * and takes a `BidderIdentity` discriminated union whose `nbfc` arm remains
 * legal at the service layer. That arm exists so historical NBFC bids stay
 * replayable and so the platform retains one way to record a bid that did not
 * come from a dealer; it simply has no HTTP surface any more.
 */
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GONE = {
  ok: false as const,
  error:
    "FORBIDDEN: NBFC users cannot bid on auction lots. Auction lots are sold to " +
    "dealers only (Battery Auction BRD §9). Dealers bid at " +
    "POST /api/dealer/auctions/[id]/bid.",
  code: "auction_nbfc_bidding_withdrawn" as const,
};

export async function POST(
  _req: NextRequest,
  _ctx: { params: Promise<{ id: string }> },
) {
  return NextResponse.json(GONE, { status: 403 });
}
