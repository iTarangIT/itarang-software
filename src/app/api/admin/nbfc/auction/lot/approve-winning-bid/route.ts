/**
 * E-069 — POST /api/admin/nbfc/auction/lot/approve-winning-bid (BRD §6.3.4)
 *
 * Post-auction confirmation of the winning bidder. Validates that the lot
 * is closed, that winning_bid_id belongs to the lot, and that the named bid
 * is the highest bid on the lot. On success an auction_settlements row is
 * inserted in 'payment_pending' status — that is the BRD's "payment
 * collection started" signal.
 *
 * 200 → { lot_id, winning_bid_id, payment_collection_started: true }
 * 400 → malformed body
 * 401 → not signed in
 * 403 → not an admin
 * 404 → lot_id or winning_bid_id does not exist
 * 409 → lot still live OR winning_bid_id is not the highest bid
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  resolveAdminActor,
  statusFromError,
  ADMIN_ROLES,
} from "@/lib/nbfc/admin/auth";
import { approveWinningBid } from "@/lib/nbfc/admin/auctionControlService";

function assertAdminRole(role: string) {
  if (!(ADMIN_ROLES as readonly string[]).includes(role)) {
    throw new Error("FORBIDDEN: not an admin");
  }
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RequestBody = z
  .object({
    lot_id: z.string().uuid(),
    winning_bid_id: z.string().uuid(),
  })
  .strict();

export async function POST(req: NextRequest) {
  try {
    const actor = await resolveAdminActor(req.headers);
    assertAdminRole(actor.role);

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

    const parsed = RequestBody.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "VALIDATION", issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const result = await approveWinningBid({
      lot_id: parsed.data.lot_id,
      winning_bid_id: parsed.data.winning_bid_id,
      actor_user_id: actor.user_id,
    });

    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: msg },
      { status: statusFromError(msg) },
    );
  }
}
