/**
 * E-083 — Battery Immobilisation (BRD §6.4.3)
 *
 * Two-step gated action:
 *   1. initiateImmobilisation(): Risk Manager creates a dual_approval_requests
 *      row of action_type='battery_immobilisation'. NO row in
 *      nbfc_immobilisation_actions yet — the action is *only* recorded once
 *      the approval is granted.
 *   2. executeImmobilisationOnApproval(): the gate dispatcher invokes this
 *      from the dual-approval approve route when an approved request has
 *      action_type='battery_immobilisation'. It writes one row to
 *      nbfc_immobilisation_actions with executed_at=now() and the IoT command
 *      id (stub in worktree-local tests; real impl dispatches to telemetry).
 *
 * Audit logs are appended on initiate and on execute.
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { and, eq } from "drizzle-orm";
import {
  nbfcImmobilisationActions,
  nbfcLoans,
  auditLogs,
} from "@/lib/db/schema";
import { createDualApprovalRequest } from "@/lib/nbfc/dual-approval/service";

const ACTION_TYPE = "battery_immobilisation" as const;

export interface InitiateInput {
  tenant_id: string;
  initiator_user_id: string;
  loan_application_id: string;
  imei: string;
  reason_code: "dpd_60" | "dpd_90" | "fraud_flag" | "manual";
  borrower_notice_id?: string | null;
}

export interface InitiateResult {
  approval_request_id: string;
  status: "pending_approval";
  action_type: typeof ACTION_TYPE;
}

/**
 * Create a pending dual-approval request for battery immobilisation.
 * The action handler runs ONLY after Approver-2 (nbfc_risk_head) approves.
 */
export async function initiateImmobilisation(
  input: InitiateInput,
): Promise<InitiateResult> {
  // Snapshot evidence — load nbfc_loans summary for the application id, scoped
  // to the calling tenant so cross-tenant lookups can't leak data.
  const loanRows = await db
    .select({
      loan_application_id: nbfcLoans.loan_application_id,
      tenant_id: nbfcLoans.tenant_id,
      vehicleno: nbfcLoans.vehicleno,
      current_dpd: nbfcLoans.current_dpd,
      outstanding_amount: nbfcLoans.outstanding_amount,
    })
    .from(nbfcLoans)
    .where(
      and(
        eq(nbfcLoans.tenant_id, input.tenant_id),
        eq(nbfcLoans.loan_application_id, input.loan_application_id),
      ),
    )
    .limit(1);

  const evidence_snapshot: Record<string, unknown> = {
    loan_application_id: input.loan_application_id,
    imei: input.imei,
    reason_code: input.reason_code,
    loan: loanRows[0] ?? null,
    snapshot_at: new Date().toISOString(),
  };

  const row = await createDualApprovalRequest({
    tenant_id: input.tenant_id,
    initiator_user_id: input.initiator_user_id,
    action_type: ACTION_TYPE,
    entity_id: input.loan_application_id,
    reason_code: input.reason_code,
    evidence_snapshot,
    borrower_notice_id: input.borrower_notice_id ?? null,
  });

  await db.insert(auditLogs).values({
    id: `nbfc.immobilisation.initiated-${row.id}-${randomUUID()}`,
    entity_type: "nbfc_immobilisation_action",
    entity_id: row.id,
    action: "nbfc.immobilisation.initiated",
    performed_by: input.initiator_user_id,
    new_data: {
      tenant_id: input.tenant_id,
      loan_application_id: input.loan_application_id,
      imei: input.imei,
      reason_code: input.reason_code,
      approval_request_id: row.id,
    },
  });

  return {
    approval_request_id: row.id,
    status: "pending_approval",
    action_type: ACTION_TYPE,
  };
}

export interface ExecuteOnApprovalInput {
  approval_request_id: string;
  tenant_id: string;
  loan_application_id: string;
  evidence_snapshot: Record<string, unknown>;
  approver_user_id: string;
  borrower_notice_id?: string | null;
}

/**
 * Side-effect handler invoked by the gate dispatcher after an approval
 * transitions to 'approved'. Idempotent — if a row already exists for the
 * given approval_request_id, returns the existing row.
 */
export async function executeImmobilisationOnApproval(
  input: ExecuteOnApprovalInput,
) {
  const existing = await db
    .select()
    .from(nbfcImmobilisationActions)
    .where(
      eq(
        nbfcImmobilisationActions.approval_request_id,
        input.approval_request_id,
      ),
    )
    .limit(1);
  if (existing.length > 0) return existing[0];

  // Resolve the IMEI from the evidence snapshot captured at initiate time.
  const imei =
    typeof input.evidence_snapshot.imei === "string"
      ? input.evidence_snapshot.imei
      : "";

  // Dispatch IoT command (stub — real implementation will hit telemetry).
  const iot_command_id = `iot-cmd-${randomUUID()}`;
  const now = new Date();

  const [row] = await db
    .insert(nbfcImmobilisationActions)
    .values({
      tenant_id: input.tenant_id,
      loan_application_id: input.loan_application_id,
      imei,
      approval_request_id: input.approval_request_id,
      iot_command_id,
      executed_at: now,
      borrower_notified_at: input.borrower_notice_id ? now : null,
    })
    .returning();

  await db.insert(auditLogs).values({
    id: `nbfc.immobilisation.executed-${row.id}-${randomUUID()}`,
    entity_type: "nbfc_immobilisation_action",
    entity_id: row.id,
    action: "nbfc.immobilisation.executed",
    performed_by: input.approver_user_id,
    new_data: {
      tenant_id: input.tenant_id,
      approval_request_id: input.approval_request_id,
      loan_application_id: input.loan_application_id,
      imei,
      iot_command_id,
    },
  });

  return row;
}

export const BATTERY_IMMOBILISATION_ACTION_TYPE = ACTION_TYPE;
