/**
 * E-069 — POST /api/admin/nbfc/auction/lot/reduce-time (BRD §6.3.4)
 *
 * Pull a live lot's closing countdown in by -15m, or end it now. MFA token
 * is mandatory (re-confirmation per BRD).
 *
 * 200 → { lot_id, new_closing_at }
 * 400 → mfa_token missing / shorter than 6 chars / bad reduce_by_minutes
 * 401 → not signed in OR mfa_token rejected by verifier
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
import { reduceTime } from "@/lib/nbfc/admin/auctionControlService";

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
    reduce_by_minutes: z.union([z.literal(0), z.literal(15)]),
    end_now: z.boolean(),
    mfa_token: z.string().min(6),
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

    const result = await reduceTime({
      lot_id: parsed.data.lot_id,
      reduce_by_minutes: parsed.data.reduce_by_minutes,
      end_now: parsed.data.end_now,
      mfa_token: parsed.data.mfa_token,
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
