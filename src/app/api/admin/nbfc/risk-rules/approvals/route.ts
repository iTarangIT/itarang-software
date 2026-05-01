/**
 * E-068 — GET /api/admin/nbfc/risk-rules/approvals
 *
 * List pending threshold change requests for the Risk Head approval queue.
 * Admin-only. Read-only.
 */
import { NextRequest, NextResponse } from "next/server";
import { resolveAdminActor, statusFromError } from "@/lib/nbfc/admin/auth";
import { listPendingChangeRequests } from "@/lib/nbfc/admin/riskRuleApprovalService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    await resolveAdminActor(req.headers);
    const requests = await listPendingChangeRequests();
    return NextResponse.json({
      requests: requests.map((r) => ({
        id: r.id,
        rule_key: r.rule_key,
        previous_value: r.previous_value,
        new_value: r.new_value,
        requested_by: r.requested_by,
        requested_at:
          r.requested_at instanceof Date
            ? r.requested_at.toISOString()
            : r.requested_at,
        status: r.status,
      })),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: msg },
      { status: statusFromError(msg) },
    );
  }
}
