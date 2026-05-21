/**
 * E-093 — POST/DELETE /api/nbfc/auction/lots/[id]/auto-bid
 *
 * BRD §6.1.7 Auto-Bid affordance on the PlaceBidModal. Stores the bidder's
 * standing-order maximum for a lot. POST upserts an 'active' row keyed by
 * (lot_id, tenant_id); DELETE cancels the active row (preserving audit).
 *
 * The actual auto-top-up engine (worker that places a bid when the user is
 * outbid, up to max_amount) lives in a follow-up — this endpoint only owns
 * the bidder-facing preference.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { auctionAutoBids, auctionLots } from "@/lib/db/schema";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  max_amount: z.number().positive(),
});

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("CONFLICT")) return 409;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const actor = await resolveActor(req.headers);
    const { id: lotId } = await ctx.params;
    if (!lotId) {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: lot id missing" }, { status: 400 });
    }

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: invalid JSON" }, { status: 400 });
    }
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: "VALIDATION", issues: parsed.error.issues }, { status: 400 });
    }

    const lot = await db
      .select({ id: auctionLots.id, base_price: auctionLots.base_price, status: auctionLots.status })
      .from(auctionLots)
      .where(eq(auctionLots.id, lotId))
      .limit(1);
    if (lot.length === 0) {
      return NextResponse.json({ ok: false, error: "NOT_FOUND: lot" }, { status: 404 });
    }
    if (lot[0].status !== "live") {
      return NextResponse.json({ ok: false, error: "CONFLICT: lot not live" }, { status: 409 });
    }
    if (parsed.data.max_amount < Number(lot[0].base_price)) {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: max_amount below lot base price" },
        { status: 400 },
      );
    }

    // Upsert via the partial-unique index on (lot_id, tenant_id) WHERE status='active'.
    // Two-step: cancel any existing active row, then insert a fresh one. Keeps
    // the cancelled history intact for audit, and works without ON CONFLICT
    // (the partial index isn't a valid target for ON CONFLICT in Drizzle).
    await db
      .update(auctionAutoBids)
      .set({ status: "cancelled", updated_at: sql`now()` })
      .where(
        and(
          eq(auctionAutoBids.lot_id, lotId),
          eq(auctionAutoBids.tenant_id, actor.tenant_id),
          eq(auctionAutoBids.status, "active"),
        ),
      );
    await db.insert(auctionAutoBids).values({
      lot_id: lotId,
      tenant_id: actor.tenant_id,
      max_amount: parsed.data.max_amount.toFixed(2),
      status: "active",
    });

    return NextResponse.json({ ok: true, max_amount: parsed.data.max_amount }, { status: 200 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: statusFromError(msg) });
  }
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const actor = await resolveActor(req.headers);
    const { id: lotId } = await ctx.params;
    if (!lotId) {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: lot id missing" }, { status: 400 });
    }

    const result = await db
      .update(auctionAutoBids)
      .set({ status: "cancelled", updated_at: sql`now()` })
      .where(
        and(
          eq(auctionAutoBids.lot_id, lotId),
          eq(auctionAutoBids.tenant_id, actor.tenant_id),
          eq(auctionAutoBids.status, "active"),
        ),
      )
      .returning({ id: auctionAutoBids.id });

    return NextResponse.json({ ok: true, cancelled: result.length }, { status: 200 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: statusFromError(msg) });
  }
}
