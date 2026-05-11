/**
 * E-039 — PATCH /api/nbfc/auction/settlements/[id]
 *
 * Transitions an auction_settlements row through:
 *   payment_pending → in_transit → delivered.
 *
 * Invalid transitions are rejected with 400. On reaching 'delivered' the
 * linked nbfc_recovery_pipeline row's stage becomes 'resold'. Every PATCH is
 * audit-logged with before_state/after_state.
 *
 * AuthN/Z: nbfc-tenant — caller must be the seller tenant for the settlement.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { patchSettlementStatus } from "@/lib/nbfc/auction/settlements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  status: z.enum(["payment_pending", "in_transit", "delivered"]),
});

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("CONFLICT")) return 409;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const actor = await resolveActor(req.headers);
    const { id } = await ctx.params;
    if (!id) {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: settlement id missing" },
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

    const result = await patchSettlementStatus({
      settlement_id: id,
      next_status: parsed.data.status,
      caller_tenant_id: actor.tenant_id,
      caller_user_id: actor.user_id,
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
