/**
 * GET /api/dealer/auctions/facets — BRD §21.
 *
 * WHY A FREE-TEXT FILTER WOULD NOT WORK
 *   `listDealerLots` matches `state` and `city` against the frozen audience row
 *   with a plain `=`: case-sensitive, no trimming. "kanpur" returns nothing,
 *   and so does "Kanpur " with a trailing space. A text box would look broken
 *   in a way the dealer could never diagnose.
 *
 *   So the filter is a select, and these are its options: the exact values that
 *   exist in THIS dealer's audience rows, straight from the column the query
 *   compares against. Every option is guaranteed to match something.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";
import {
  requireAuctionDealer,
  auctionApiError,
} from "@/lib/nbfc/auction/dealerView";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const actor = await requireAuctionDealer();

    // Scoped to lots the dealer can actually see, and to statuses the grid can
    // show, so the dropdown never offers a filter that yields an empty list.
    const rows = (await db.execute(sql`
      SELECT DISTINCT a.state, a.city
        FROM auction_lot_audience a
        JOIN auction_lots l ON l.id = a.lot_id
       WHERE a.dealer_id = ${actor.dealer_id}
         AND l.status IN ('live', 'ended')
    `)) as unknown as Array<{ state: string | null; city: string | null }>;

    const states = [
      ...new Set(rows.map((r) => r.state).filter((s): s is string => !!s)),
    ].sort();
    const cities = [
      ...new Set(rows.map((r) => r.city).filter((c): c is string => !!c)),
    ].sort();

    return NextResponse.json({
      success: true,
      data: { states, cities },
    });
  } catch (e) {
    const { body, status } = auctionApiError(e);
    return NextResponse.json(body, { status });
  }
}
