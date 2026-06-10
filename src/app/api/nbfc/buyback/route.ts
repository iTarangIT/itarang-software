/**
 * E-118 — GET /api/nbfc/buyback
 *
 * Lists customer battery-buyback requests for the caller's NBFC tenant.
 * Optional filter by status (pending_evaluation | offer_made | accepted |
 * rejected). The Recovery & Auction page renders these server-side; this
 * route exists for parity and future client-side refetch.
 *
 * AuthN/Z: nbfc-tenant — caller must be a member of an NBFC tenant; the result
 * is scoped to buyback requests where tenant_id == caller's tenant_id.
 */
import { NextRequest, NextResponse } from "next/server";
import { clientError } from "@/lib/nbfc/http-error";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { nbfcBuybackRequests } from "@/lib/db/schema";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Query = z.object({
  status: z
    .enum(["pending_evaluation", "offer_made", "accepted", "rejected"])
    .optional(),
});

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

export async function GET(req: NextRequest) {
  try {
    const actor = await resolveActor(req.headers);

    const url = new URL(req.url);
    const parsed = Query.safeParse({
      status: url.searchParams.get("status") ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "VALIDATION", issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const where = parsed.data.status
      ? and(
          eq(nbfcBuybackRequests.tenant_id, actor.tenant_id),
          eq(nbfcBuybackRequests.status, parsed.data.status),
        )
      : eq(nbfcBuybackRequests.tenant_id, actor.tenant_id);

    const rows = await db
      .select()
      .from(nbfcBuybackRequests)
      .where(where)
      .orderBy(desc(nbfcBuybackRequests.requested_at))
      .limit(100);

    return NextResponse.json({ ok: true, rows }, { status: 200 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: clientError(msg) },
      { status: statusFromError(msg) },
    );
  }
}
