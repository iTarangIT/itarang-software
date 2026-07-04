/**
 * POST /api/admin/nbfc/financing-offers/approvals/:id/approve
 *
 * The iTarang CEO (platform-level role, §5.1) approves an out-of-band financing
 * offer deviation (§13.3.4). Unlike the NBFC-tenant dual-approval routes, this is
 * authenticated against the admin/CEO session (the CEO is not an NBFC member).
 * Approval releases the held offer to the dealer via the dual-approval dispatcher.
 */
import { NextRequest, NextResponse } from "next/server";
import { clientError } from "@/lib/nbfc/http-error";

import { requireAuth } from "@/lib/auth-utils";
import { approveDualApprovalRequest } from "@/lib/nbfc/dual-approval/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CEO_EMAIL = "sanchit@itarang.com";
const CEO_APPROVER_ROLE = "itarang_ceo";

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("CONFLICT")) return 409;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const user = await requireAuth();
    const isCeo = (user.role ?? "").toLowerCase() === "ceo" || (user.email ?? "").toLowerCase() === CEO_EMAIL;
    if (!isCeo) {
      return NextResponse.json({ ok: false, error: "FORBIDDEN: iTarang CEO approval required" }, { status: 403 });
    }
    let comment: string | undefined;
    try {
      const text = await req.text();
      const body = text ? (JSON.parse(text) as { comment?: string }) : {};
      comment = typeof body.comment === "string" ? body.comment.slice(0, 500) : undefined;
    } catch {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: invalid JSON" }, { status: 400 });
    }

    // The service dispatches the approval side-effect (releases the offer) and
    // is idempotent on the offer's pending state.
    const row = await approveDualApprovalRequest({
      request_id: id,
      approver_user_id: user.id,
      approver_role: CEO_APPROVER_ROLE,
      comment,
    });

    return NextResponse.json({ ok: true, id: row.id, status: row.status, approved_at: row.approved_at });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: statusFromError(msg) });
  }
}
