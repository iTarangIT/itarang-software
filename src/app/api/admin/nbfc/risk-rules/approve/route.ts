/**
 * E-068 — POST /api/admin/nbfc/risk-rules/approve
 *
 * Step 2 of the dual-approval commit workflow. A *different* admin (Risk
 * Head) approves or rejects the pending change. On approve, we atomically
 * write the new value to nbfc_risk_rules.current_value, flip the request to
 * 'executed', and append an audit log entry with action='RISK_RULE_CHANGED'
 * carrying both before/after values and both approver IDs.
 *
 * 200 → { request_id, status: 'executed' | 'rejected', applied_at }
 * 400 → malformed body
 * 401 → not signed in
 * 403 → same admin as requester (self-approval), or non-admin role
 * 404 → request_id not found
 * 409 → request not in pending_second_approval state
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveAdminActor, statusFromError } from "@/lib/nbfc/admin/auth";
import { approveChangeRequest } from "@/lib/nbfc/admin/riskRuleApprovalService";

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

    const result = await approveChangeRequest({
      request_id: parsed.data.request_id,
      approver_user_id: actor.user_id,
      approver_role: actor.role,
      decision: parsed.data.decision,
    });

    return NextResponse.json({
      request_id: result.request_id,
      status: result.status,
      applied_at: result.applied_at,
      rule_key: result.rule_key,
      previous_value: result.previous_value,
      new_value: result.new_value,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: msg },
      { status: statusFromError(msg) },
    );
  }
}
