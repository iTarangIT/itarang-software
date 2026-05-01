/**
 * Dual-approval service — pure DB operations. The HTTP routes call into these.
 *
 * The service layer intentionally has no `Request` / `Response` types so it
 * can be exercised by the cron sweep AND by the API routes uniformly.
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { and, eq, lt } from "drizzle-orm";
import {
  dualApprovalRequests,
  dualApprovalActionConfig,
  auditLogs,
} from "@/lib/db/schema";

export type DualApprovalStatus =
  | "pending_approval"
  | "approved"
  | "rejected"
  | "expired";

export const DUAL_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

const FALLBACK_APPROVER_ROLES: Record<string, string> = {
  battery_immobilisation: "nbfc_risk_head",
  loan_restructuring: "nbfc_credit_manager",
  risk_rule_threshold_change: "itarang_risk_head",
  bulk_immobilisation: "itarang_admin",
  auction_lot_cancellation: "itarang_super_admin",
  audit_log_export: "itarang_compliance_officer",
  pii_data_access: "itarang_compliance_officer",
};

export async function resolveRequiredApproverRole(
  actionType: string,
): Promise<string> {
  const rows = await db
    .select({ role: dualApprovalActionConfig.approver_role })
    .from(dualApprovalActionConfig)
    .where(eq(dualApprovalActionConfig.action_type, actionType))
    .limit(1);
  if (rows.length > 0) return rows[0].role;
  const fallback = FALLBACK_APPROVER_ROLES[actionType];
  if (!fallback) {
    throw new Error(
      `BAD_REQUEST: no approver_role configured for action_type='${actionType}'`,
    );
  }
  return fallback;
}

export interface CreateRequestInput {
  tenant_id: string;
  initiator_user_id: string;
  action_type: string;
  entity_id: string;
  reason_code: string;
  evidence_snapshot: Record<string, unknown>;
  borrower_notice_id?: string | null;
}

export async function createDualApprovalRequest(input: CreateRequestInput) {
  const requiredRole = await resolveRequiredApproverRole(input.action_type);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + DUAL_APPROVAL_TTL_MS);
  const [row] = await db
    .insert(dualApprovalRequests)
    .values({
      tenant_id: input.tenant_id,
      action_type: input.action_type,
      entity_id: input.entity_id,
      initiator_user_id: input.initiator_user_id,
      required_approver_role: requiredRole,
      status: "pending_approval",
      reason_code: input.reason_code,
      evidence_snapshot: input.evidence_snapshot as unknown as object,
      borrower_notice_id: input.borrower_notice_id ?? null,
      created_at: now,
      expires_at: expiresAt,
    })
    .returning();

  await appendAudit({
    request_id: row.id,
    tenant_id: input.tenant_id,
    action: "dual_approval.created",
    performed_by: input.initiator_user_id,
    payload: {
      action_type: row.action_type,
      entity_id: row.entity_id,
      required_approver_role: row.required_approver_role,
    },
  });

  return row;
}

export interface ApproveInput {
  request_id: string;
  approver_user_id: string;
  approver_role: string;
  comment?: string;
}

export async function approveDualApprovalRequest(input: ApproveInput) {
  const existing = await db
    .select()
    .from(dualApprovalRequests)
    .where(eq(dualApprovalRequests.id, input.request_id))
    .limit(1);
  if (existing.length === 0) throw new Error("NOT_FOUND: request not found");
  const row = existing[0];

  if (row.status !== "pending_approval") {
    throw new Error(`CONFLICT: request is in status '${row.status}'`);
  }
  const now = new Date();
  if (row.expires_at && row.expires_at.getTime() < now.getTime()) {
    throw new Error("CONFLICT: request expired");
  }
  if (row.initiator_user_id === input.approver_user_id) {
    throw new Error("FORBIDDEN: initiator cannot self-approve");
  }
  if (row.required_approver_role !== input.approver_role) {
    throw new Error(
      `FORBIDDEN: approver role '${input.approver_role}' does not match required '${row.required_approver_role}'`,
    );
  }

  const [updated] = await db
    .update(dualApprovalRequests)
    .set({
      status: "approved",
      approver_user_id: input.approver_user_id,
      approved_at: now,
    })
    .where(eq(dualApprovalRequests.id, input.request_id))
    .returning();

  await appendAudit({
    request_id: updated.id,
    tenant_id: updated.tenant_id,
    action: "dual_approval.approved",
    performed_by: input.approver_user_id,
    payload: {
      action_type: updated.action_type,
      entity_id: updated.entity_id,
      initiator_user_id: updated.initiator_user_id,
      comment: input.comment ?? null,
    },
  });

  // E-083 — Gate dispatcher: route action_type to its side-effect handler.
  // Handlers are idempotent on approval_request_id (their own table guards),
  // so cron retries or double-clicks cannot double-execute.
  await dispatchOnApproved(updated, input.approver_user_id);

  return updated;
}

/**
 * Gate dispatcher — invoked exactly once per approve transition. Adds new
 * action_types here as they ship. Imports are lazy to avoid circular module
 * resolution between this service and per-action services.
 */
async function dispatchOnApproved(
  approved: {
    id: string;
    action_type: string;
    tenant_id: string;
    entity_id: string;
    evidence_snapshot: unknown;
    borrower_notice_id: string | null;
  },
  approver_user_id: string,
) {
  if (approved.action_type === "battery_immobilisation") {
    const { executeImmobilisationOnApproval } = await import(
      "@/lib/nbfc/actions/battery-immobilisation/service"
    );
    await executeImmobilisationOnApproval({
      approval_request_id: approved.id,
      tenant_id: approved.tenant_id,
      loan_application_id: approved.entity_id,
      evidence_snapshot:
        (approved.evidence_snapshot as Record<string, unknown>) ?? {},
      approver_user_id,
      borrower_notice_id: approved.borrower_notice_id,
    });
  }
  // Other action_types (loan_restructuring, risk_rule_threshold_change, etc.)
  // will register here as they ship.
}

export interface RejectInput {
  request_id: string;
  approver_user_id: string;
  approver_role: string;
  rejection_reason: string;
}

export async function rejectDualApprovalRequest(input: RejectInput) {
  const existing = await db
    .select()
    .from(dualApprovalRequests)
    .where(eq(dualApprovalRequests.id, input.request_id))
    .limit(1);
  if (existing.length === 0) throw new Error("NOT_FOUND: request not found");
  const row = existing[0];

  if (row.status !== "pending_approval") {
    throw new Error(`CONFLICT: request is in status '${row.status}'`);
  }
  const now = new Date();
  if (row.expires_at && row.expires_at.getTime() < now.getTime()) {
    throw new Error("CONFLICT: request expired");
  }
  if (row.initiator_user_id === input.approver_user_id) {
    throw new Error("FORBIDDEN: initiator cannot self-reject");
  }
  if (row.required_approver_role !== input.approver_role) {
    throw new Error(
      `FORBIDDEN: approver role '${input.approver_role}' does not match required '${row.required_approver_role}'`,
    );
  }

  const [updated] = await db
    .update(dualApprovalRequests)
    .set({
      status: "rejected",
      approver_user_id: input.approver_user_id,
      rejected_at: now,
      rejection_reason: input.rejection_reason,
    })
    .where(eq(dualApprovalRequests.id, input.request_id))
    .returning();

  await appendAudit({
    request_id: updated.id,
    tenant_id: updated.tenant_id,
    action: "dual_approval.rejected",
    performed_by: input.approver_user_id,
    payload: {
      action_type: updated.action_type,
      entity_id: updated.entity_id,
      initiator_user_id: updated.initiator_user_id,
      rejection_reason: input.rejection_reason,
    },
  });

  return updated;
}

/**
 * Cron sweep: any pending_approval row with expires_at < now() is flipped to
 * 'expired' and an audit log row is appended. Returns the rows that were
 * expired in this sweep.
 */
export async function expireStaleDualApprovalRequests(now: Date = new Date()) {
  const stale = await db
    .select()
    .from(dualApprovalRequests)
    .where(
      and(
        eq(dualApprovalRequests.status, "pending_approval"),
        lt(dualApprovalRequests.expires_at, now),
      ),
    );

  const expired: typeof stale = [];
  for (const row of stale) {
    const [updated] = await db
      .update(dualApprovalRequests)
      .set({ status: "expired", expired_at: now })
      .where(
        and(
          eq(dualApprovalRequests.id, row.id),
          eq(dualApprovalRequests.status, "pending_approval"),
        ),
      )
      .returning();
    if (updated) {
      expired.push(updated);
      await appendAudit({
        request_id: updated.id,
        tenant_id: updated.tenant_id,
        action: "dual_approval.expired",
        performed_by: updated.initiator_user_id,
        payload: {
          action_type: updated.action_type,
          entity_id: updated.entity_id,
          expired_at: now.toISOString(),
        },
      });
    }
  }
  return expired;
}

interface AuditPayload {
  request_id: string;
  tenant_id: string;
  action: string;
  performed_by: string | null;
  payload: Record<string, unknown>;
}

async function appendAudit(input: AuditPayload) {
  const id = `${input.action}-${input.request_id}-${randomUUID()}`;
  await db.insert(auditLogs).values({
    id,
    entity_type: "dual_approval_request",
    entity_id: input.request_id,
    action: input.action,
    performed_by: input.performed_by ?? null,
    new_data: { tenant_id: input.tenant_id, ...input.payload },
  });
}
