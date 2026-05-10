/**
 * E-069 — POST /api/admin/nbfc/auction/lot/extend-time (BRD §6.3.4)
 *
 * Extend a live lot's closing countdown by +15m / +30m / +1h. Reason is
 * mandatory and is logged on the per-lot action audit trail.
 *
 * 200 → { lot_id, new_closing_at }
 * 400 → invalid body / empty reason / non-15-30-60 minutes
 * 401 → not signed in
 * 403 → not an admin
 * 404 → lot_id does not exist
 * 409 → lot is not in 'live' status
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  resolveAdminActor,
  statusFromError,
  ADMIN_ROLES,
} from "@/lib/nbfc/admin/auth";
import { extendTime } from "@/lib/nbfc/admin/auctionControlService";

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
    extend_by_minutes: z.union([
      z.literal(15),
      z.literal(30),
      z.literal(60),
    ]),
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

    const result = await extendTime({
      lot_id: parsed.data.lot_id,
      extend_by_minutes: parsed.data.extend_by_minutes,
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
