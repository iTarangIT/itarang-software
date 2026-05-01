/**
 * E-070 — POST /api/admin/nbfc/auction/lot/cancel/approve
 *
 * Step 2 of the Cancel Lot dual-approval workflow (BRD §6.3.4). A *different*
 * admin loads the pending request and either approves or rejects. On approve,
 * we atomically cancel the lot, return the underlying battery to inventory
 * (lot.lot_code → inventory.serial_number), flip the request to 'executed',
 * and write an audit log row with action='AUCTION_LOT_CANCELLED'.
 *
 * 200 → { request_id, status: 'executed' | 'rejected', battery_returned_to_inventory, applied_at }
 * 400 → malformed body / non-uuid request_id / unknown decision
 * 401 → not signed in
 * 403 → same admin as requester (self-approval forbidden)
 * 404 → request_id not found
 * 409 → request not in pending_second_approval state
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveAdminActor, statusFromError } from "@/lib/nbfc/admin/auth";
import { approveCancelRequest } from "@/lib/nbfc/admin/auctionCancelService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ApproveBody = z
  .object({
    request_id: z.string().uuid(),
    decision: z.enum(["approve", "reject"]),
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

    const parsed = ApproveBody.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "VALIDATION", issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const result = await approveCancelRequest({
      request_id: parsed.data.request_id,
      approver_user_id: actor.user_id,
      decision: parsed.data.decision,
    });

    const status =
      result.status === "executed"
        ? "executed"
        : ("rejected" as "executed" | "rejected");

    return NextResponse.json({
      request_id: result.request_id,
      status,
      battery_returned_to_inventory: result.battery_returned_to_inventory,
      applied_at: result.applied_at,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: msg },
      { status: statusFromError(msg) },
    );
  }
}
