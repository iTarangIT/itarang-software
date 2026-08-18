/**
 * GET /api/admin/nbfc/auction/analytics — BRD §19-adjacent.
 *
 * The question the business asks the week after launch: is auctioning
 * recovered batteries recovering more value than scrapping them would?
 *
 * Every figure is DERIVED from `auction_lots`, `auction_bids` and
 * `auction_settlements`. There is no new write path, no new table and no
 * nightly job — an analytics surface that needs its own storage to answer
 * questions about data it does not own is a second source of truth waiting to
 * disagree with the first.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";
import { clientError } from "@/lib/nbfc/http-error";
import {
  resolveAdminActor,
  statusFromError,
  ADMIN_ROLES,
} from "@/lib/nbfc/admin/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const actor = await resolveAdminActor(req.headers);
    if (!(ADMIN_ROLES as readonly string[]).includes(actor.role)) {
      throw new Error("FORBIDDEN: admin role required");
    }

    const days = Number(
      new URL(req.url).searchParams.get("days") ?? "90",
    );
    const window = Number.isFinite(days) && days > 0 ? Math.min(days, 365) : 90;

    const [row] = (await db.execute(sql`
      WITH closed AS (
        SELECT l.id, l.base_price, l.reserve_price, l.published_at, l.ends_at,
               (SELECT MAX(b.amount) FROM auction_bids b WHERE b.lot_id = l.id) AS top_bid,
               (SELECT COUNT(*)::int FROM auction_bids b WHERE b.lot_id = l.id) AS bid_count,
               (SELECT MIN(b.placed_at) FROM auction_bids b WHERE b.lot_id = l.id) AS first_bid_at,
               (SELECT COUNT(DISTINCT a.dealer_id)::int
                  FROM auction_lot_audience a WHERE a.lot_id = l.id)             AS reach,
               (SELECT COUNT(DISTINCT b.bidder_dealer_id)::int
                  FROM auction_bids b WHERE b.lot_id = l.id
                   AND b.bidder_dealer_id IS NOT NULL)                           AS bidders
          FROM auction_lots l
         WHERE l.status IN ('ended', 'cancelled')
           AND l.ends_at > now() - (${window} || ' days')::interval
      )
      SELECT
        (SELECT COUNT(*)::int FROM closed)                                   AS closed_lots,
        (SELECT COUNT(*)::int FROM closed WHERE top_bid IS NULL)             AS no_bid_lots,
        (SELECT COUNT(*)::int FROM closed
          WHERE reserve_price IS NOT NULL AND COALESCE(top_bid, 0) < reserve_price)
                                                                             AS reserve_not_met,
        (SELECT COUNT(*)::int FROM auction_settlements s
           JOIN auction_lots l ON l.id = s.lot_id
          WHERE l.ends_at > now() - (${window} || ' days')::interval)        AS settlements,
        (SELECT COALESCE(SUM(s.final_price), 0) FROM auction_settlements s
           JOIN auction_lots l ON l.id = s.lot_id
          WHERE l.ends_at > now() - (${window} || ' days')::interval)        AS realised_value,
        (SELECT COALESCE(SUM(l.base_price), 0) FROM auction_settlements s
           JOIN auction_lots l ON l.id = s.lot_id
          WHERE l.ends_at > now() - (${window} || ' days')::interval)        AS base_value,
        (SELECT COALESCE(AVG(bid_count), 0) FROM closed)                     AS avg_bids,
        (SELECT COALESCE(AVG(reach), 0) FROM closed)                         AS avg_reach,
        (SELECT COALESCE(AVG(bidders), 0) FROM closed)                       AS avg_bidders,
        (SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (first_bid_at - published_at)) / 60), 0)
           FROM closed WHERE first_bid_at IS NOT NULL AND published_at IS NOT NULL)
                                                                             AS avg_first_bid_minutes,
        (SELECT COUNT(*)::int FROM auction_settlements s
          WHERE s.paid_at IS NOT NULL)                                       AS paid_settlements,
        (SELECT COUNT(*)::int FROM auction_settlements s
          WHERE s.refinance_loan_id IS NOT NULL)                             AS refinanced
    `)) as unknown as Array<Record<string, unknown>>;

    const closedLots = Number(row?.closed_lots ?? 0);
    const noBid = Number(row?.no_bid_lots ?? 0);
    const settlements = Number(row?.settlements ?? 0);
    const realised = Number(row?.realised_value ?? 0);
    const base = Number(row?.base_value ?? 0);

    return NextResponse.json({
      ok: true,
      window_days: window,
      closed_lots: closedLots,
      settlements,
      // Of the lots that closed, how many actually sold.
      sell_through: closedLots > 0 ? settlements / closedLots : null,
      no_bid_lots: noBid,
      no_bid_rate: closedLots > 0 ? noBid / closedLots : null,
      reserve_not_met: Number(row?.reserve_not_met ?? 0),
      realised_value: realised,
      base_value: base,
      // Above 1.0 means the auction beat the price the evaluation put on the
      // stock — the single number that answers "was this worth doing".
      realisation_ratio: base > 0 ? realised / base : null,
      avg_bids_per_lot: Number(row?.avg_bids ?? 0),
      avg_reach: Number(row?.avg_reach ?? 0),
      avg_bidders: Number(row?.avg_bidders ?? 0),
      // Reach is how many were told; bidders is how many acted. The gap is the
      // marketing problem, and it is invisible without both.
      engagement_rate:
        Number(row?.avg_reach ?? 0) > 0
          ? Number(row?.avg_bidders ?? 0) / Number(row?.avg_reach ?? 0)
          : null,
      avg_minutes_to_first_bid: Number(row?.avg_first_bid_minutes ?? 0),
      paid_settlements: Number(row?.paid_settlements ?? 0),
      refinanced: Number(row?.refinanced ?? 0),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: clientError(msg) },
      { status: statusFromError(msg) },
    );
  }
}
