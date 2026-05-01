/**
 * E-082 — POST /api/nbfc/dual-approval/requests/:id/approve
 * Second approver executes the action. 403 if same user as initiator or role
 * mismatch; 409 if not pending or expired.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { approveDualApprovalRequest } from "@/lib/nbfc/dual-approval/service";
import { executeApprovedBulkImmobilisation } from "@/lib/nbfc/actions/bulk-immobilisation";
import { finaliseExportIfApproved } from "@/lib/nbfc/audit-export/service";
import { executeImmobilisationOnApproval } from "@/lib/nbfc/actions/battery-immobilisation/service";
import { applyLoanRestructuring } from "@/lib/nbfc/actions/loan-restructuring";
import { mintGrantIfApproved } from "@/lib/nbfc/pii-access/service";

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

    // Post-approval action-type dispatcher (concat of all gated units).
    // Each branch is idempotent on the approval_request_id / entity_id, so
    // cron retries or double-clicks cannot double-execute. Failures here do
    // not roll back the approval — the approval is the record of authorisation,
    // each handler is the execution.
    if (row.status === "approved") {
      switch (row.action_type) {
        case "bulk_immobilisation":
          // E-086 — bulk immobilisation per-loan rows in nbfc_borrower_actions
          // and the batch's executed_count visible in the same response.
          await executeApprovedBulkImmobilisation(row.id);
          break;
        case "battery_immobilisation":
          // E-083 — IoT immobilisation dispatch + per-loan action row.
          await executeImmobilisationOnApproval({
            approval_request_id: row.id,
            tenant_id: row.tenant_id,
            loan_application_id: row.entity_id,
            evidence_snapshot:
              (row.evidence_snapshot as Record<string, unknown>) ?? {},
            approver_user_id: actor.user_id,
            borrower_notice_id: row.borrower_notice_id,
          });
          break;
        case "loan_restructuring":
          // E-084 — apply new EMI fields and append restructure history row.
          await applyLoanRestructuring(row.id);
          break;
        case "pii_data_access":
          // E-089 — mint a single-use, time-boxed PII unmask grant.
          await mintGrantIfApproved(row.id);
          break;
        case "audit_log_export":
          // E-088 — synthesise the signed download URL + checksum on the
          // linked nbfc_audit_log_exports row. Retryable out of band.
          if (row.entity_id) {
            try {
              await finaliseExportIfApproved(row.entity_id);
            } catch {
              // eslint-disable-next-line no-console
              console.error("[E-088] finaliseExportIfApproved failed", {
                entity_id: row.entity_id,
              });
            }
          }
          break;
        default:
          // No handler registered for this action_type — nothing to do.
          break;
      }
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
    return NextResponse.json(
      { ok: false, error: msg },
      { status: statusFromError(msg) },
    );
  }
}
