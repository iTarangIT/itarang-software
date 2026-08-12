/**
 * E-234 — GET /api/nbfc/auction/lots/[id]
 *
 * Full seller-side detail for one lot: its items, its visibility rule, its
 * audience size, and the bid history WITH bidder identity — the seller is
 * entitled to know who is bidding on their own stock. The dealer-facing
 * projection at /api/dealer/auctions/[id] deliberately omits it (BRD §11:
 * highest bid visible, bidder name hidden).
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { desc, eq, sql } from "drizzle-orm";
import { clientError } from "@/lib/nbfc/http-error";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { getLotDetail } from "@/lib/nbfc/auction/composeLot";
import {
  auctionBids,
  auctionLotAudience,
  auctionLotVisibility,
  accounts,
} from "@/lib/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("CONFLICT")) return 409;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const actor = await resolveActor(req.headers);
    const { id } = await ctx.params;

    const lot = await getLotDetail(id);
    if (!lot) {
      return NextResponse.json(
        { ok: false, error: "NOT_FOUND: lot not found" },
        { status: 404 },
      );
    }
    // A seller sees their own lots. Pre-E-232 lots have no seller and are
    // reachable only from the platform-wide admin surface.
    if (lot.seller_tenant_id !== actor.tenant_id) {
      return NextResponse.json(
        { ok: false, error: "FORBIDDEN: this lot belongs to another NBFC" },
        { status: 403 },
      );
    }

    const [visibility] = await db
      .select()
      .from(auctionLotVisibility)
      .where(eq(auctionLotVisibility.lot_id, id))
      .limit(1);

    const [audienceCount] = await db
      .select({ n: sql<number>`count(DISTINCT ${auctionLotAudience.dealer_id})::int` })
      .from(auctionLotAudience)
      .where(eq(auctionLotAudience.lot_id, id));

    const bids = await db
      .select({
        id: auctionBids.id,
        amount: auctionBids.amount,
        placed_at: auctionBids.placed_at,
        bidder_kind: auctionBids.bidder_kind,
        bidder_dealer_id: auctionBids.bidder_dealer_id,
        bidder_name: accounts.business_entity_name,
      })
      .from(auctionBids)
      .leftJoin(accounts, eq(accounts.id, auctionBids.bidder_dealer_id))
      .where(eq(auctionBids.lot_id, id))
      .orderBy(desc(auctionBids.amount), auctionBids.placed_at);

    return NextResponse.json({
      ok: true,
      lot,
      visibility: visibility ?? null,
      audience_dealers: Number(audienceCount?.n ?? 0),
      bids: bids.map((b) => ({
        id: b.id,
        amount: Number(b.amount),
        placed_at: (b.placed_at as Date).toISOString(),
        bidder_kind: b.bidder_kind,
        bidder_dealer_id: b.bidder_dealer_id,
        bidder_name: b.bidder_name ?? null,
      })),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: clientError(msg) },
      { status: statusFromError(msg) },
    );
  }
}
