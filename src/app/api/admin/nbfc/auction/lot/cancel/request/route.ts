/**
 * E-070 — POST /api/admin/nbfc/auction/lot/cancel/request
 *
 * Step 1 of the Cancel Lot dual-approval workflow (BRD §6.3.4). The first
 * admin (requester) supplies a fresh MFA token, the lot to cancel, and a
 * mandatory non-empty reason. We validate, then insert a row with
 * status='pending_second_approval' and return the request_id for the second
 * admin to approve.
 *
 * 200 → { request_id, status: 'pending_second_approval' }
 * 400 → empty reason / malformed body / non-uuid lot_id / mfa_token < 6 chars
 * 401 → not signed in OR mfa_token rejected by verifier (e.g. "INVALID...")
 * 403 → not an admin
 * 404 → lot_id does not exist
 * 409 → lot already cancelled
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveAdminActor, statusFromError } from "@/lib/nbfc/admin/auth";
import { createCancelRequest } from "@/lib/nbfc/admin/auctionCancelService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RequestBody = z
  .object({
    lot_id: z.string().uuid(),
    reason: z.string().min(1),
    mfa_token: z.string().min(6),
  })
  .strict();

export async function POST(req: NextRequest) {
  try {
    const actor = await resolveAdminActor(req.headers);

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
      // 400 — empty reason, missing mfa_token, non-uuid lot_id (covers AC2).
      return NextResponse.json(
        { ok: false, error: "VALIDATION", issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const result = await createCancelRequest({
      lot_id: parsed.data.lot_id,
      reason: parsed.data.reason,
      mfa_token: parsed.data.mfa_token,
      requester_user_id: actor.user_id,
    });

    return NextResponse.json({
      request_id: result.request_id,
      status: result.status,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: msg },
      { status: statusFromError(msg) },
    );
  }
}
