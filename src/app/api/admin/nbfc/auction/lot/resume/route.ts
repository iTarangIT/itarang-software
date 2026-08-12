/**
 * E-232 — POST /api/admin/nbfc/auction/lot/resume
 *
 * The missing counterpart to /pause. Pause shipped without a resume, and since
 * every other Auction Control Centre action requires `status === "live"`, a
 * paused lot could only leave that state by being CANCELLED — an irreversible,
 * dual-approval action, reached because somebody wanted a ten-minute breather.
 *
 * `ends_at` is pushed out by however long the lot actually sat paused, so a
 * resumed auction runs for the duration bidders were promised rather than
 * whatever was left when it froze.
 *
 * 200 → { lot_id, status: 'live', ends_at, extended_by_minutes }
 * 400 → empty reason / malformed body
 * 401 → not signed in
 * 403 → not an admin
 * 404 → lot_id does not exist
 * 409 → lot is not 'paused'
 */
import { NextRequest, NextResponse } from "next/server";
import { clientError } from "@/lib/nbfc/http-error";
import { z } from "zod";
import {
  resolveAdminActor,
  statusFromError,
  ADMIN_ROLES,
} from "@/lib/nbfc/admin/auth";
import { resumeAuction } from "@/lib/nbfc/admin/auctionControlService";

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

    const result = await resumeAuction({
      lot_id: parsed.data.lot_id,
      reason: parsed.data.reason,
      actor_user_id: actor.user_id,
    });

    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: clientError(msg) },
      { status: statusFromError(msg) },
    );
  }
}
