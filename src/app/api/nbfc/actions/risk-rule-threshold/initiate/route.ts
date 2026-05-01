/**
 * E-085 — POST /api/nbfc/actions/risk-rule-threshold/initiate
 *
 * iTarang Admin initiates a risk-rule threshold change. Creates a
 * dual_approval_requests row (status='pending_approval', action_type=
 * 'risk_rule_threshold_change'). The actual threshold mutation happens only
 * after a second approver (iTarang Risk Head or Super Admin) approves the
 * dual-approval request.
 *
 * AuthN/Z: getCurrentTenant + requireNbfcAccess (canonical NBFC route idiom)
 * with the same triple-guarded test bypass used by the rest of the loop.
 * Authorisation requires the caller's role to be an iTarang Admin role
 * (`itarang_admin` or `admin`); else 403.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { initiateThresholdChange } from "@/lib/nbfc/risk-rule-thresholds/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const InitiateBody = z.object({
  rule_key: z.string().min(1),
  current_threshold_json: z.record(z.string(), z.unknown()),
  proposed_threshold_json: z.record(z.string(), z.unknown()),
  reason_code: z.string().min(1),
  reviewed_evidence_ack: z.literal(true),
});

const ITARANG_ADMIN_ROLES = new Set(["itarang_admin", "admin"]);

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("CONFLICT")) return 409;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

export async function POST(req: NextRequest) {
  try {
    const actor = await resolveActor(req.headers);
    if (!ITARANG_ADMIN_ROLES.has(actor.role)) {
      return NextResponse.json(
        {
          ok: false,
          error: `FORBIDDEN: only iTarang Admin may initiate risk rule threshold changes (role='${actor.role}')`,
        },
        { status: 403 },
      );
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: invalid JSON" },
        { status: 400 },
      );
    }
    const parsed = InitiateBody.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "VALIDATION", issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const row = await initiateThresholdChange({
      tenant_id: actor.tenant_id,
      initiator_user_id: actor.user_id,
      rule_key: parsed.data.rule_key,
      current_threshold_json: parsed.data.current_threshold_json,
      proposed_threshold_json: parsed.data.proposed_threshold_json,
      reason_code: parsed.data.reason_code,
    });

    return NextResponse.json(
      {
        approval_request_id: row.id,
        status: row.status,
        action_type: row.action_type,
        entity_id: row.entity_id,
        required_approver_role: row.required_approver_role,
        created_at: row.created_at,
        expires_at: row.expires_at,
      },
      { status: 200 },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: msg },
      { status: statusFromError(msg) },
    );
  }
}
