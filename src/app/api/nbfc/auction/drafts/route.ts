/**
 * GET /api/nbfc/auction/drafts
 *
 * The composer's resume list. Separate from `GET /lots?status=draft` because
 * that route returns the marketplace card shape (current bid, bidder count) —
 * meaningless for something that has never been published — while a draft list
 * needs its items, so an operator can tell two three-battery drafts apart
 * without opening both.
 */
import { NextRequest, NextResponse } from "next/server";
import { clientError } from "@/lib/nbfc/http-error";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { listDraftLots } from "@/lib/nbfc/auction/draftLot";

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

export async function GET(req: NextRequest) {
  try {
    const actor = await resolveActor(req.headers);
    const items = await listDraftLots(actor.tenant_id);
    return NextResponse.json({ ok: true, items, total: items.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: clientError(msg) },
      { status: statusFromError(msg) },
    );
  }
}
