/**
 * E-234 — POST /api/dealer/auctions/[id]/bid (Battery Auction BRD §9, §11)
 *
 * The dealer bidding path. This is the route the closed
 * /api/nbfc/auction/lots/[id]/bid was replaced by.
 *
 * `confirmed: true` is required, unchanged from E-038: bids are binding and
 * irreversible, and the client has to say so explicitly rather than the server
 * inferring consent from a POST.
 *
 * Three gates, in order, each refusing for a different reason:
 *   1. requireAuctionDealer — an NBFC user is refused by ROLE (§9), not by
 *      geography, so the rule holds even inside the lot's radius.
 *   2. assertDealerMayBid  — the caller must be in the lot's FROZEN audience.
 *   3. placeBid            — locks the lot row, re-checks live/deadline/amount.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  auctionApiError,
  assertDealerMayBid,
  requireAuctionDealer,
} from "@/lib/nbfc/auction/dealerView";
import { placeBid } from "@/lib/nbfc/auction/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z
  .object({
    amount: z.number().positive(),
    confirmed: z.literal(true),
  })
  .strict();

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
        {
          success: false,
          error: {
            message:
              "A bid needs a positive amount and an explicit confirmation — bids are binding.",
          },
          issues: parsed.error.issues,
        },
        { status: 400 },
      );
    }

    await assertDealerMayBid(actor.dealer_id, id);

    const result = await placeBid({
      lot_id: id,
      amount: parsed.data.amount,
      confirmed: true,
      bidder: {
        kind: "dealer",
        dealer_id: actor.dealer_id,
        user_id: actor.user_id,
      },
    });

    // A rejected bid is a 200 with accepted:false, not an error status: nothing
    // went wrong, the amount was simply too low, and the response carries the
    // number that would have worked. Same contract as E-038.
    return NextResponse.json({ success: true, data: result });
  } catch (e) {
    const { body, status } = auctionApiError(e);
    return NextResponse.json(body, { status });
  }
}
