/**
 * E-234 — GET /api/dealer/auctions (Battery Auction BRD §10, §21)
 *
 * The dealer's lot grid, scoped to the lots this dealer's account is in the
 * frozen audience for. Filters are applied server-side over that scoped set —
 * type, price band, state, city, distance, ending-soon, newest.
 *
 * No bidder identity is ever in the response (§11).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  auctionApiError,
  listDealerLots,
  requireAuctionDealer,
} from "@/lib/nbfc/auction/dealerView";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Query = z.object({
  status: z.enum(["live", "ending_soon", "ended", "all"]).default("live"),
  condition: z.enum(["new", "refurbished", "partial_working"]).optional(),
  auction_type: z.enum(["cash", "cash_refinance"]).optional(),
  state: z.string().trim().min(1).optional(),
  city: z.string().trim().min(1).optional(),
  min_price: z.coerce.number().min(0).optional(),
  max_price: z.coerce.number().min(0).optional(),
  max_distance_km: z.coerce.number().min(0).optional(),
  sort: z
    .enum(["ending_soon", "newest", "price_asc", "price_desc", "nearest"])
    .default("ending_soon"),
  page: z.coerce.number().int().min(1).default(1),
});

export async function GET(req: NextRequest) {
  try {
    const actor = await requireAuctionDealer();
    const url = new URL(req.url);

    const parsed = Query.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: { message: "Invalid filters" }, issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const result = await listDealerLots({
      dealer_id: actor.dealer_id,
      ...parsed.data,
    });

    return NextResponse.json({ success: true, data: result });
  } catch (e) {
    const { body, status } = auctionApiError(e);
    return NextResponse.json(body, { status });
  }
}
