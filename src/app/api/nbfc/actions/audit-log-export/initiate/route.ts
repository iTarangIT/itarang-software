/**
 * E-088 — POST /api/nbfc/actions/audit-log-export/initiate
 *
 * Bulk audit-log export initiation, gated by:
 *   1. MFA challenge in the same session (mfa_token must be valid),
 *   2. E-082 dual-approval flow with required_approver_role =
 *      'itarang_compliance_officer'.
 *
 * Producing the signed download URL is *not* the responsibility of this
 * endpoint — it only creates the pending approval and the
 * `nbfc_audit_log_exports` row with mfa_verified_at set. The signed URL +
 * checksum are populated by the dual-approval `/approve` endpoint's
 * post-approval side-effect (`finaliseExportIfApproved`).
 *
 * Status codes:
 *   200 — pending approval created
 *   400 — invalid body / time range
 *   401 — invalid or missing MFA token
 *   403 — caller lacks NBFC access
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { initiateAuditLogExport } from "@/lib/nbfc/audit-export/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  from_ts: z.string().datetime(),
  to_ts: z.string().datetime(),
  entity_type: z.string().optional(),
  mfa_token: z.string().min(1),
  reason_code: z.string().min(1),
  reviewed_evidence_ack: z.literal(true),
});

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

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: invalid JSON" },
        { status: 400 },
      );
    }
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "VALIDATION", issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const result = await initiateAuditLogExport({
      tenant_id: actor.tenant_id,
      requested_by: actor.user_id,
      from_ts: parsed.data.from_ts,
      to_ts: parsed.data.to_ts,
      entity_type: parsed.data.entity_type ?? null,
      mfa_token: parsed.data.mfa_token,
      reason_code: parsed.data.reason_code,
    });

    return NextResponse.json(
      {
        approval_request_id: result.approval_request_id,
        status: result.status,
        action_type: result.action_type,
        export_request_id: result.export_request_id,
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
