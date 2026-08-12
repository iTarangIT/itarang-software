/**
 * E-234 — GET /api/admin/nbfc/auction/lots
 *
 * The platform-wide lot listing the Auction Control Centre is built on.
 *
 * WHY A NEW ROUTE FOR A READ
 *   All eight admin auction endpoints are POST actions that each take a
 *   `lot_id`. There has never been a way to FIND that id: the control surface
 *   existed with no way to see what it controlled, which is why it shipped
 *   without a screen. This is the missing read.
 *
 * Unlike `/api/nbfc/auction/lots`, this is NOT scoped to one seller — an admin
 * governs every NBFC's lots. The seller tenant is returned with each row so the
 * screen can say whose lot it is rather than presenting them as the platform's.
 *
 * 200 → ListLotsResult + per-lot audience/settlement counters
 * 401 → not signed in
 * 403 → not an admin
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { inArray, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  auctionLotAudience,
  auctionSettlements,
  nbfcTenants,
} from "@/lib/db/schema";
import { clientError } from "@/lib/nbfc/http-error";
import {
  resolveAdminActor,
  statusFromError,
  ADMIN_ROLES,
} from "@/lib/nbfc/admin/auth";
import {
  listLots,
  AUCTION_LOT_STATUSES,
  type AuctionLotStatus,
} from "@/lib/nbfc/auction/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Query = z.object({
  status: z.enum([...AUCTION_LOT_STATUSES, "all"] as [string, ...string[]]).default("live"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export async function GET(req: NextRequest) {
  try {
    const actor = await resolveAdminActor(req.headers);
    if (!(ADMIN_ROLES as readonly string[]).includes(actor.role)) {
      throw new Error("FORBIDDEN: not an admin");
    }

    const url = new URL(req.url);
    const parsed = Query.safeParse({
      status: url.searchParams.get("status") ?? undefined,
      page: url.searchParams.get("page") ?? undefined,
      pageSize: url.searchParams.get("pageSize") ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "VALIDATION", issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const result = await listLots({
      status: parsed.data.status as AuctionLotStatus | "all",
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
    });

    const lotIds = result.items.map((i) => i.lot_id);
    const tenantIds = [
      ...new Set(result.items.map((i) => i.seller_tenant_id).filter(Boolean)),
    ] as string[];

    // Three small lookups rather than three joins on the main query: the page
    // is capped at 200 rows, and keeping listLots() shared with the NBFC
    // listing is worth more than saving two round-trips here.
    const [sellers, fanout, settled] = await Promise.all([
      tenantIds.length
        ? db
            .select({ id: nbfcTenants.id, name: nbfcTenants.display_name })
            .from(nbfcTenants)
            .where(inArray(nbfcTenants.id, tenantIds))
        : Promise.resolve([]),
      lotIds.length
        ? db
            .select({
              lot_id: auctionLotAudience.lot_id,
              dealers: sql<number>`count(distinct ${auctionLotAudience.dealer_id})::int`,
              pending: sql<number>`count(*) filter (where ${auctionLotAudience.status} = 'pending')::int`,
              failed: sql<number>`count(*) filter (where ${auctionLotAudience.status} = 'failed')::int`,
            })
            .from(auctionLotAudience)
            .where(inArray(auctionLotAudience.lot_id, lotIds))
            .groupBy(auctionLotAudience.lot_id)
        : Promise.resolve([]),
      lotIds.length
        ? db
            .select({
              lot_id: auctionSettlements.lot_id,
              status: auctionSettlements.status,
              final_price: auctionSettlements.final_price,
              winner_dealer_id: auctionSettlements.winner_dealer_id,
            })
            .from(auctionSettlements)
            .where(inArray(auctionSettlements.lot_id, lotIds))
        : Promise.resolve([]),
    ]);

    // The winning bid's id, which `approve-winning-bid` requires as a
    // parameter. Without it the Control Centre could show an "Approve winner"
    // button it had no way to call — the reason that action has been
    // unreachable from any UI. DISTINCT ON picks one row per lot; the ORDER BY
    // inside it is the same tie-break the scheduler uses (highest, then
    // earliest), so the admin approves exactly the bid the close job chose.
    const topBids = lotIds.length
      ? ((await db.execute(sql`
          SELECT DISTINCT ON (lot_id)
                 lot_id, id AS bid_id, amount, bidder_dealer_id
            FROM auction_bids
           WHERE lot_id IN ${lotIds}
           ORDER BY lot_id, amount DESC, placed_at ASC
        `)) as unknown as Array<Record<string, unknown>>)
      : [];
    const topBidByLot = new Map(topBids.map((b) => [String(b.lot_id), b]));

    const sellerById = new Map(sellers.map((s) => [s.id, s.name]));
    const fanoutById = new Map(fanout.map((f) => [f.lot_id, f]));
    const settledById = new Map(settled.map((s) => [s.lot_id, s]));

    return NextResponse.json({
      ok: true,
      page: result.page,
      total: result.total,
      items: result.items.map((i) => {
        const f = fanoutById.get(i.lot_id);
        const s = settledById.get(i.lot_id);
        const t = topBidByLot.get(i.lot_id);
        return {
          ...i,
          top_bid_id: t?.bid_id ? String(t.bid_id) : null,
          top_bidder_dealer_id: t?.bidder_dealer_id
            ? String(t.bidder_dealer_id)
            : null,
          seller_name: i.seller_tenant_id
            ? (sellerById.get(i.seller_tenant_id) ?? null)
            : null,
          audience_dealers: f?.dealers ?? 0,
          audience_pending: f?.pending ?? 0,
          audience_failed: f?.failed ?? 0,
          settlement: s
            ? {
                status: s.status,
                final_price: s.final_price ? Number(s.final_price) : null,
                winner_dealer_id: s.winner_dealer_id ?? null,
              }
            : null,
        };
      }),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: clientError(msg) },
      { status: statusFromError(msg) },
    );
  }
}
