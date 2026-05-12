/**
 * E-038 — GET /api/nbfc/auction/lots
 *
 * Lists auction lots filtered by status (live | ended). Each item includes the
 * derived `current_bid` (MAX over auction_bids) and `bidder_count` (DISTINCT
 * tenant_id over auction_bids).
 *
 * AuthN/Z: any authenticated NBFC tenant (via `resolveActor`). The list is
 * platform-wide for this release — bidder eligibility filtering is deferred
 * to a later unit.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { listLots } from "@/lib/nbfc/auction/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Query = z.object({
  status: z.enum(["live", "ended"]).default("live"),
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
    await resolveActor(req.headers);

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

    const result = await listLots({
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
