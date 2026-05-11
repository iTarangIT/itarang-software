/**
 * E-069 — POST /api/admin/nbfc/auction/lot/pause (BRD §6.3.4)
 *
 * Temporarily suspend bidding on a live lot. The countdown is frozen by
 * flipping lot.status to 'paused'. The number of bidders that would be
 * notified is returned (the notification dispatch itself lives in E-061's
 * notification pipeline).
 *
 * 200 → { lot_id, status: 'paused', notified_bidders }
 * 400 → empty reason / malformed body
 * 401 → not signed in
 * 403 → not an admin
 * 404 → lot_id does not exist
 * 409 → lot is not 'live'
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  resolveAdminActor,
  statusFromError,
  ADMIN_ROLES,
} from "@/lib/nbfc/admin/auth";
import { pauseAuction } from "@/lib/nbfc/admin/auctionControlService";

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
    reason: z.string().min(1),
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

    const result = await pauseAuction({
      lot_id: parsed.data.lot_id,
      reason: parsed.data.reason,
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
