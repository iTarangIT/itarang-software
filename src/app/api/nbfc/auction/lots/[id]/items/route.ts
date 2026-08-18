/**
 * POST / DELETE /api/nbfc/auction/lots/[id]/items
 *
 * Add batteries to a draft lot, or take one off it. Both re-derive the lot's
 * quantity, base price, increment, capacity, average SOH and age from whatever
 * is left on it — a lot's headline figures can never drift away from the stock
 * actually being sold.
 *
 * DELETE takes `?battery_id=` rather than a body: a DELETE with a request body
 * is legal but poorly supported by intermediaries, and one battery at a time is
 * what the composer's remove button actually does.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { clientError } from "@/lib/nbfc/http-error";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { addLotItems, removeLotItem } from "@/lib/nbfc/auction/draftLot";

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

const AddBody = z
  .object({
    // Same ceiling as compose: 50 batteries is already an unusually large
    // pallet, and the audience fan-out is sized for lots, not warehouses.
    battery_ids: z.array(z.string().uuid()).min(1).max(50),
  })
  .strict();

export async function POST(
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

    const parsed = AddBody.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "VALIDATION", issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const lot = await addLotItems({
      tenant_id: actor.tenant_id,
      actor_user_id: actor.user_id,
      lot_id: id,
      battery_ids: parsed.data.battery_ids,
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

    const batteryId = new URL(req.url).searchParams.get("battery_id");
    const parsed = z.string().uuid().safeParse(batteryId);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: battery_id must be a uuid" },
        { status: 400 },
      );
    }

    const lot = await removeLotItem({
      tenant_id: actor.tenant_id,
      actor_user_id: actor.user_id,
      lot_id: id,
      battery_id: parsed.data,
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
