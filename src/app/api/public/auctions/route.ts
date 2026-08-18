/**
 * GET /api/public/auctions — BRD §16.
 *
 * The first genuinely UNAUTHENTICATED surface in this application, which is
 * why the payload matters more than the page.
 *
 * WHAT IS DELIBERATELY ABSENT
 *   · Any bidder data at all — no names, no ids, and no bid COUNT either. A
 *     count is not identity, but "3 bidders" plus a small local market is
 *     enough to infer who, and there is no reason a stranger needs it.
 *   · The reserve price. It is hidden from bidders who are logged in; it is
 *     certainly not going out over an open endpoint.
 *   · The current bid. Only the opening price is shown, so the page cannot be
 *     scraped as a live price feed by anyone who is not eligible to bid.
 *   · Anything that is not `live`. Drafts, scheduled, paused and cancelled lots
 *     are all internal states, and a lot that was pulled must not linger in a
 *     public cache.
 *
 * The audience join is dropped on purpose — this is the shop window, not the
 * bidding floor. Being able to SEE that an auction exists is not the same as
 * being allowed to bid on it, and bidding still requires a dealer login.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

export const runtime = "nodejs";
// Short cache rather than force-dynamic: a countdown a minute stale is fine on
// a marketing page, and the load profile of an open endpoint is unknown.
export const revalidate = 60;

export async function GET() {
  try {
    const rows = (await db.execute(sql`
      SELECT l.id,
             l.lot_code,
             l.title,
             l.quantity,
             l.capacity,
             l.avg_soh,
             l.base_price,
             l.ends_at,
             l.auction_type,
             it.conditions,
             it.image_url
        FROM auction_lots l
        LEFT JOIN (
          SELECT i.lot_id,
                 array_agg(DISTINCT i.condition) AS conditions,
                 (array_agg(rb.image_urls[1])
                    FILTER (WHERE rb.image_urls[1] IS NOT NULL))[1] AS image_url
            FROM auction_lot_items i
            LEFT JOIN recovery_batteries rb ON rb.id = i.battery_id
           GROUP BY i.lot_id
        ) it ON it.lot_id = l.id
       WHERE l.status = 'live'
         AND l.ends_at > now()
       ORDER BY l.ends_at ASC
       LIMIT 60
    `)) as unknown as Array<Record<string, unknown>>;

    return NextResponse.json({
      success: true,
      data: {
        items: rows.map((r) => ({
          lot_code: String(r.lot_code),
          title: r.title ? String(r.title) : null,
          quantity: Number(r.quantity),
          capacity: r.capacity ? String(r.capacity) : null,
          avg_soh: r.avg_soh === null ? null : Number(r.avg_soh),
          // The OPENING price, never the current bid.
          base_price: Number(r.base_price),
          ends_at: new Date(String(r.ends_at)).toISOString(),
          auction_type: String(r.auction_type),
          conditions: (r.conditions as string[] | null) ?? [],
          image_url: r.image_url ? String(r.image_url) : null,
        })),
      },
    });
  } catch (e) {
    console.error("[public/auctions]", e);
    // Never leak an internal message to an anonymous caller.
    return NextResponse.json(
      { success: false, error: { message: "Auctions are unavailable." } },
      { status: 500 },
    );
  }
}
