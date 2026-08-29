/**
 * POST /api/nbfc/auction/lots/[id]/approve-winner — BRD §12.
 *
 * "The highest bid is suggested; the NBFC has the final say." Until now the
 * final say belonged exclusively to an iTarang admin: `approveWinningBid()` was
 * reachable only through `/api/admin/nbfc/auction/lot/approve-winning-bid`,
 * which is gated on an admin role. A seller could watch their own lot close and
 * then had to ask someone else to release it.
 *
 * Same service, same invariants — the bid must belong to the lot and must be
 * the highest — with the ownership check swapped from "is an admin" to "owns
 * this lot".
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { clientError } from "@/lib/nbfc/http-error";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { getLotDetail } from "@/lib/nbfc/auction/composeLot";
import { approveWinningBid } from "@/lib/nbfc/admin/auctionControlService";

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

const Body = z
  .object({
    winning_bid_id: z.string().uuid(),
    /** Step-up credential; enforced by the service in production. */
    mfa_token: z.string().min(1).optional(),
  })
  .strict();

export async function POST(
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
    if (lot.seller_tenant_id !== actor.tenant_id) {
      return NextResponse.json(
        { ok: false, error: "FORBIDDEN: this lot belongs to another NBFC" },
        { status: 403 },
      );
    }

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: invalid JSON" },
        { status: 400 },
      );
    }

    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "VALIDATION", issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const result = await approveWinningBid({
      lot_id: id,
      winning_bid_id: parsed.data.winning_bid_id,
      actor_user_id: actor.user_id,
      mfa_token: parsed.data.mfa_token ?? null,
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
