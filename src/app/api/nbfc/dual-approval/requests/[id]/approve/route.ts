/**
 * E-082 — POST /api/nbfc/dual-approval/requests/:id/approve
 * Second approver executes the action. 403 if same user as initiator or role
 * mismatch; 409 if not pending or expired.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { approveDualApprovalRequest } from "@/lib/nbfc/dual-approval/service";
import { finaliseExportIfApproved } from "@/lib/nbfc/audit-export/service";

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
    // E-088: post-approval side-effect for audit log exports — synthesise the
    // signed download URL + checksum on the linked nbfc_audit_log_exports row.
    if (row.action_type === "audit_log_export" && row.entity_id) {
      try {
        await finaliseExportIfApproved(row.entity_id);
      } catch {
        // Failure here must not undo the approval; the export can be
        // retried by an out-of-band worker. We log via console only.
        // eslint-disable-next-line no-console
        console.error("[E-088] finaliseExportIfApproved failed", {
          entity_id: row.entity_id,
        });
      }
    }
    return NextResponse.json({
      id: row.id,
      status: row.status,
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
