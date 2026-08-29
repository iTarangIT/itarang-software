/**
 * E-234 — GET / PATCH / DELETE /api/nbfc/auction/lots/[id]
 *
 * GET gives full seller-side detail for one lot: its items, its visibility
 * rule, its audience size, and the bid history WITH bidder identity — the
 * seller is entitled to know who is bidding on their own stock. The
 * dealer-facing projection at /api/dealer/auctions/[id] deliberately omits it
 * (BRD §11: highest bid visible, bidder name hidden).
 *
 * PATCH edits a draft's scalar fields; DELETE discards a draft and releases
 * its batteries. Both refuse anything past `draft` — once a lot is scheduled
 * or live, its price is the basis of live bids and its audience is frozen.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { desc, eq, sql } from "drizzle-orm";
import { clientError } from "@/lib/nbfc/http-error";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { getLotDetail, AUCTION_TYPES } from "@/lib/nbfc/auction/composeLot";
import { updateDraftLot, discardDraftLot } from "@/lib/nbfc/auction/draftLot";
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

/**
 * `.strict()`, like every other NBFC write body — an operator UI that
 * round-trips a lot object would otherwise silently 400 on an extra key.
 * `.partial()` semantics are explicit here: an absent key means "leave it",
 * and an explicit `null` on reserve_price means "clear it".
 */
const PatchBody = z
  .object({
    title: z.string().trim().max(160).nullable().optional(),
    auction_type: z.enum(AUCTION_TYPES).optional(),
    base_price: z.number().positive().optional(),
    reserve_price: z.number().positive().nullable().optional(),
    bid_increment: z.number().positive().optional(),
    anti_snipe_seconds: z.number().int().min(0).max(900).optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, {
    message: "nothing to update",
  });

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

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const actor = await resolveActor(req.headers);
    const { id } = await ctx.params;

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: invalid JSON" },
        { status: 400 },
      );
    }

    const parsed = PatchBody.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "VALIDATION", issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const lot = await updateDraftLot({
      tenant_id: actor.tenant_id,
      actor_user_id: actor.user_id,
      lot_id: id,
      ...parsed.data,
    });

    return NextResponse.json({ ok: true, lot });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: clientError(msg) },
      { status: statusFromError(msg) },
    );
  }
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const actor = await resolveActor(req.headers);
    const { id } = await ctx.params;

    const result = await discardDraftLot({
      tenant_id: actor.tenant_id,
      actor_user_id: actor.user_id,
      lot_id: id,
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: clientError(msg) },
      { status: statusFromError(msg) },
    );
  }
}
