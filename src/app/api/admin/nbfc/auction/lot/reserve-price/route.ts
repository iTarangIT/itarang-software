/**
 * E-069 — POST /api/admin/nbfc/auction/lot/reserve-price (BRD §6.3.4)
 *
 * Set or change the reserve (floor) price on a lot. Only allowed pre-bid:
 * if any bid exists on the lot, returns 409.
 *
 * 200 → { lot_id, previous_reserve_price_inr, new_reserve_price_inr }
 * 400 → non-positive price / malformed body
 * 401 → not signed in
 * 403 → not an admin
 * 404 → lot_id does not exist
 * 409 → at least one bid exists on the lot
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  resolveAdminActor,
  statusFromError,
  ADMIN_ROLES,
} from "@/lib/nbfc/admin/auth";
import { setReservePrice } from "@/lib/nbfc/admin/auctionControlService";

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
    reserve_price_inr: z.number().positive(),
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

    const result = await setReservePrice({
      lot_id: parsed.data.lot_id,
      reserve_price_inr: parsed.data.reserve_price_inr,
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
