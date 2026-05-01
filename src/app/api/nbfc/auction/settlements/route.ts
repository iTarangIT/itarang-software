/**
 * E-039 — GET /api/nbfc/auction/settlements
 *
 * Lists post-auction settlement rows for lots whose seller tenant matches the
 * caller. Optional filter by status (payment_pending | in_transit | delivered).
 *
 * AuthN/Z: nbfc-tenant — caller must be a member of an NBFC tenant; the result
 * is scoped to settlements where seller_tenant_id == caller's tenant_id.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { listSettlements } from "@/lib/nbfc/auction/settlements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Query = z.object({
  status: z.enum(["payment_pending", "in_transit", "delivered"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
});

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("CONFLICT")) return 409;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

export async function GET(req: NextRequest) {
  try {
    const actor = await resolveActor(req.headers);

    const url = new URL(req.url);
    const parsed = Query.safeParse({
      status: url.searchParams.get("status") ?? undefined,
      page: url.searchParams.get("page") ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "VALIDATION", issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const result = await listSettlements({
      caller_tenant_id: actor.tenant_id,
      status: parsed.data.status,
      page: parsed.data.page,
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
