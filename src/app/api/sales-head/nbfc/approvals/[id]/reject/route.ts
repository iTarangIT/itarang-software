/**
 * POST /api/sales-head/nbfc/approvals/:id/reject
 *
 * iTarang sales_head rejects an NBFC-initiated dual_approval_requests row.
 * Body: { rejection_reason: string }
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth-utils";
import { rejectDualApprovalRequest } from "@/lib/nbfc/dual-approval/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ rejection_reason: z.string().min(3).max(500) });

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
        { ok: false, error: `FORBIDDEN: role '${user.role}' cannot reject NBFC requests; sales_head required` },
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

    const row = await rejectDualApprovalRequest({
      request_id: id,
      approver_user_id: user.id,
      approver_role: "sales_head",
      rejection_reason: parsed.data.rejection_reason,
    });

    return NextResponse.json({
      id: row.id,
      status: row.status,
      action_type: row.action_type,
      approver_user_id: row.approver_user_id,
      rejected_at: row.rejected_at,
      rejection_reason: row.rejection_reason,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: statusFromError(msg) });
  }
}
