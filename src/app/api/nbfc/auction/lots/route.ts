/**
 * E-038 — GET /api/nbfc/auction/lots
 *
 * Lists auction lots filtered by status. Each item includes the derived
 * `current_bid` (MAX over auction_bids) and `bidder_count` (DISTINCT bidder).
 *
 * E-232: the status filter used to be a hard `live | ended` union, which meant
 * a paused or cancelled lot vanished from every screen in the product instead
 * of showing as paused. It now spans the full vocabulary plus `all`.
 *
 * E-232: the listing is scoped to the caller's own tenant as SELLER. This is a
 * seller-side view — "my stock, in the market" — not a bidding surface, and it
 * must not show one NBFC another's recovered stock (Battery Auction BRD §9).
 * Lots created before E-232 have no `seller_tenant_id` and therefore appear to
 * nobody here; they remain reachable from the platform-wide admin listing.
 */
import { NextRequest, NextResponse } from "next/server";
import { clientError } from "@/lib/nbfc/http-error";
import { z } from "zod";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { listLots, AUCTION_LOT_STATUSES } from "@/lib/nbfc/auction/service";
import { composeLot, AUCTION_TYPES } from "@/lib/nbfc/auction/composeLot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Query = z.object({
  status: z.enum([...AUCTION_LOT_STATUSES, "all"]).default("live"),
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

    const result = await listLots({
      status: parsed.data.status,
      page: parsed.data.page,
      seller_tenant_id: actor.tenant_id,
    });

    return NextResponse.json(result, { status: 200 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: clientError(msg) },
      { status: statusFromError(msg) },
    );
  }
}

/**
 * POST — compose a DRAFT lot from a set of the caller's recovered batteries.
 *
 * Composing does not publish. The window, the visibility rule and the audience
 * are all decided at POST /api/nbfc/auction/lots/[id]/publish, which is the
 * deliberate step that replaced the old auto-publish-on-stage-change.
 */
const ComposeBody = z
  .object({
    battery_ids: z.array(z.string().uuid()).min(1).max(50),
    title: z.string().trim().max(160).optional(),
    auction_type: z.enum(AUCTION_TYPES).optional(),
    base_price: z.number().positive().optional(),
    reserve_price: z.number().positive().optional(),
    bid_increment: z.number().positive().optional(),
    anti_snipe_seconds: z.number().int().min(0).max(900).optional(),
  })
  .strict();

export async function POST(req: NextRequest) {
  try {
    const actor = await resolveActor(req.headers);

    let raw: unknown;
    try {
      const text = await req.text();
      raw = text ? JSON.parse(text) : {};
    } catch {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: invalid JSON" },
        { status: 400 },
      );
    }

    const parsed = ComposeBody.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "VALIDATION", issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const lot = await composeLot({
      tenant_id: actor.tenant_id,
      actor_user_id: actor.user_id,
      ...parsed.data,
    });

    return NextResponse.json({ ok: true, lot }, { status: 201 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: clientError(msg) },
      { status: statusFromError(msg) },
    );
  }
}
