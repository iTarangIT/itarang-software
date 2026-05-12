/**
 * POST /api/sales-head/nbfc/approvals/:id/approve
 *
 * iTarang sales_head approves an NBFC-initiated dual_approval_requests row
 * (typically action_type='battery_immobilisation'). Uses iTarang session auth
 * (requireAuth) — distinct from /api/nbfc/dual-approval/requests/:id/approve,
 * which expects an NBFC-tenant user.
 *
 * On success, dispatches the post-approval side effect via the same service
 * layer used by the NBFC route (e.g. executeImmobilisationOnApproval writes
 * nbfc_immobilisation_actions).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth-utils";
import { approveDualApprovalRequest } from "@/lib/nbfc/dual-approval/service";
import { executeImmobilisationOnApproval } from "@/lib/nbfc/actions/battery-immobilisation/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ comment: z.string().max(500).optional() });

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
    const user = await requireAuth();
    if (user.role !== "sales_head") {
      return NextResponse.json(
        { ok: false, error: `FORBIDDEN: role '${user.role}' cannot approve NBFC requests; sales_head required` },
        { status: 403 },
      );
    }

    const { id } = await ctx.params;
    let body: unknown = {};
    try {
      const text = await req.text();
      body = text ? JSON.parse(text) : {};
    } catch {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: invalid JSON" }, { status: 400 });
    }
    const parsed = Body.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "VALIDATION", issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const row = await approveDualApprovalRequest({
      request_id: id,
      approver_user_id: user.id,
      approver_role: "sales_head",
      comment: parsed.data.comment,
    });

    // Dispatch the side effect for action types the service-layer dispatcher
    // does not cover. battery_immobilisation IS handled inside the service
    // (dispatchOnApproved), so no second execution here.
    if (row.status === "approved" && row.action_type === "battery_immobilisation") {
      // Idempotent on approval_request_id — service-layer already called this.
      // We retry here only as a safety net in case the service-layer dispatch
      // failed silently (logged in audit but did not throw).
      await executeImmobilisationOnApproval({
        approval_request_id: row.id,
        tenant_id: row.tenant_id,
        loan_application_id: row.entity_id,
        evidence_snapshot: (row.evidence_snapshot as Record<string, unknown>) ?? {},
        approver_user_id: user.id,
        borrower_notice_id: row.borrower_notice_id,
      }).catch(() => {
        /* silenced — first-pass dispatch already audited */
      });
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
    return NextResponse.json({ ok: false, error: msg }, { status: statusFromError(msg) });
  }
}
