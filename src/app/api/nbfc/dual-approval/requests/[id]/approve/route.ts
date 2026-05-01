/**
 * E-082 — POST /api/nbfc/dual-approval/requests/:id/approve
 * Second approver executes the action. 403 if same user as initiator or role
 * mismatch; 409 if not pending or expired.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { approveDualApprovalRequest } from "@/lib/nbfc/dual-approval/service";
import { executeApprovedBulkImmobilisation } from "@/lib/nbfc/actions/bulk-immobilisation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ApproveBody = z.object({
  comment: z.string().max(500).optional(),
});

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("CONFLICT")) return 409;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params;
    const actor = await resolveActor(req.headers);
    let body: unknown = {};
    try {
      const text = await req.text();
      body = text ? JSON.parse(text) : {};
    } catch {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: invalid JSON" },
        { status: 400 },
      );
    }
    const parsed = ApproveBody.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "VALIDATION", issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const row = await approveDualApprovalRequest({
      request_id: id,
      approver_user_id: actor.user_id,
      approver_role: actor.role,
      comment: parsed.data.comment,
    });

    // E-086 — bulk immobilisation handler runs synchronously after approval
    // so per-loan rows in nbfc_borrower_actions and the batch's executed_count
    // are visible to the caller in the same transaction window.
    if (row.action_type === "bulk_immobilisation" && row.status === "approved") {
      await executeApprovedBulkImmobilisation(row.id);
    }

    return NextResponse.json({
      id: row.id,
      status: row.status,
      action_type: row.action_type,
      approver_user_id: row.approver_user_id,
      approved_at: row.approved_at,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: msg },
      { status: statusFromError(msg) },
    );
  }
}
