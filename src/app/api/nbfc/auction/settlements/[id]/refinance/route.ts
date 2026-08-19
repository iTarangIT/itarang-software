/**
 * POST /api/nbfc/auction/settlements/[id]/refinance — BRD §14.
 *
 * Raises the sanction behind a `cash_refinance` win. See
 * `@/lib/nbfc/auction/refinance` for the assumption this makes about WHO the
 * loan sits with — it is a business question that has not been settled, and the
 * module records which way it was answered.
 */
import { NextRequest, NextResponse } from "next/server";
import { clientError } from "@/lib/nbfc/http-error";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { createRefinanceSanction } from "@/lib/nbfc/auction/refinance";

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

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const actor = await resolveActor(req.headers);
    const { id } = await ctx.params;

    const result = await createRefinanceSanction({
      settlement_id: id,
      actor_tenant_id: actor.tenant_id,
      actor_user_id: actor.user_id,
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
