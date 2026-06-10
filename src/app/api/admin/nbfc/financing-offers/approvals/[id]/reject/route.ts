/**
 * POST /api/admin/nbfc/financing-offers/approvals/:id/reject
 *
 * The iTarang CEO rejects an out-of-band financing offer deviation (§13.3.4).
 * The offer stays HELD (ceo_approval_status='rejected'); the NBFC's credit
 * officer must revise the terms and resubmit. Reject requires a reason.
 */
import { NextRequest, NextResponse } from "next/server";
import { clientError } from "@/lib/nbfc/http-error";
import { z } from "zod";

import { requireAuth } from "@/lib/auth-utils";
import { rejectDualApprovalRequest } from "@/lib/nbfc/dual-approval/service";
import { applyFinancingOfferDeviationRejection } from "@/lib/nbfc/actions/financing-offer-deviation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CEO_EMAIL = "sanchit@itarang.com";
const CEO_APPROVER_ROLE = "itarang_ceo";

const Body = z.object({ rejection_reason: z.string().min(3).max(500) });

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
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: invalid JSON" }, { status: 400 });
    }
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: "VALIDATION", issues: parsed.error.issues }, { status: 400 });
    }

    const row = await rejectDualApprovalRequest({
      request_id: id,
      approver_user_id: user.id,
      approver_role: CEO_APPROVER_ROLE,
      rejection_reason: parsed.data.rejection_reason,
    });

    // rejectDualApprovalRequest has no dispatcher — apply the offer side-effect here.
    await applyFinancingOfferDeviationRejection({ offer_id: row.entity_id, approver_user_id: user.id });

    return NextResponse.json({ ok: true, id: row.id, status: row.status, rejected_at: row.rejected_at });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: statusFromError(msg) });
  }
}
