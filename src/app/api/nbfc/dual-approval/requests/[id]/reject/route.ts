/**
 * E-082 — POST /api/nbfc/dual-approval/requests/:id/reject
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { rejectDualApprovalRequest } from "@/lib/nbfc/dual-approval/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RejectBody = z.object({
  rejection_reason: z.string().min(1).max(500),
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
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: invalid JSON" },
        { status: 400 },
      );
    }
    const parsed = RejectBody.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "VALIDATION", issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const row = await rejectDualApprovalRequest({
      request_id: id,
      approver_user_id: actor.user_id,
      approver_role: actor.role,
      rejection_reason: parsed.data.rejection_reason,
    });
    return NextResponse.json({
      id: row.id,
      status: row.status,
      approver_user_id: row.approver_user_id,
      rejected_at: row.rejected_at,
      rejection_reason: row.rejection_reason,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: msg },
      { status: statusFromError(msg) },
    );
  }
}
