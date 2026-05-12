/**
 * E-038 — POST /api/nbfc/auction/lots/[id]/bid
 *
 * BRD §6.1.7: places a binding bid against a live auction lot. The caller
 * MUST send `confirmed: true` (the binding-confirmation contract) — bids are
 * irreversible and immutably logged in nbfc_audit_log.
 *
 * Validation order:
 *   1. Auth (resolveActor) — caller's tenant_id and user_id are required.
 *   2. Body schema (zod) — amount > 0, confirmed === true.
 *   3. Lot must exist, be 'live', and not past ends_at.
 *   4. amount >= current_bid + bid_increment, else accepted=false.
 *
 * On accept: insert auction_bids row + insert nbfc_audit_log row with
 * action_type='auction_bid' and amount captured in after_state.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { placeBid } from "@/lib/nbfc/auction/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  amount: z.number().positive(),
  confirmed: z.literal(true),
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
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: lot id missing" },
        { status: 400 },
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

    const result = await placeBid({
      lot_id: lotId,
      amount: parsed.data.amount,
      confirmed: parsed.data.confirmed,
      tenant_id: actor.tenant_id,
      user_id: actor.user_id,
    });

    return NextResponse.json(result, { status: 200 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: msg },
      { status: statusFromError(msg) },
    );
  }
}
