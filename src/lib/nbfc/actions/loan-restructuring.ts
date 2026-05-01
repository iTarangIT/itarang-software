/**
 * E-084 — Loan Restructuring action.
 *
 * BRD §6.4.3: Loan Restructuring is gated by dual approval — the NBFC Risk
 * Manager initiates, the NBFC Credit Manager approves. Only after the
 * dual_approval_requests row flips to status='approved' does this handler
 * mutate `nbfc_loans` (EMI amount, tenure, due-DOM) and append a row to
 * `nbfc_loan_restructures` with prior vs new terms.
 *
 * Pure DB operations — exercised both by the API initiate endpoint (which
 * creates a pending dual-approval request) and by the post-approval
 * dispatcher (which executes the restructure when status flips to approved).
 */
import { db } from "@/lib/db";
import { eq } from "drizzle-orm";
import {
  nbfcLoans,
  nbfcLoanRestructures,
  dualApprovalRequests,
} from "@/lib/db/schema";
import { createDualApprovalRequest } from "@/lib/nbfc/dual-approval/service";

export const LOAN_RESTRUCTURING_ACTION_TYPE = "loan_restructuring";
export const LOAN_RESTRUCTURING_INITIATOR_ROLE = "nbfc_risk_manager";

export interface InitiateRestructureInput {
  tenant_id: string;
  initiator_user_id: string;
  loan_application_id: string;
  new_emi_amount: number;
  new_tenure_months: number;
  new_emi_due_dom: number;
  reason_code: string;
}

/**
 * Snapshots the current loan EMI / outstanding state and creates a pending
 * dual-approval request. Does NOT mutate nbfc_loans.
 */
export async function initiateLoanRestructuring(input: InitiateRestructureInput) {
  const loanRows = await db
    .select()
    .from(nbfcLoans)
    .where(eq(nbfcLoans.loan_application_id, input.loan_application_id))
    .limit(1);
  if (loanRows.length === 0) {
    throw new Error("NOT_FOUND: loan_application_id not found");
  }
  const loan = loanRows[0];
  if (loan.tenant_id !== input.tenant_id) {
    throw new Error("FORBIDDEN: loan does not belong to tenant");
  }

  const evidence_snapshot = {
    prior_emi_amount: loan.emi_amount,
    prior_emi_due_date_dom: loan.emi_due_date_dom,
    prior_outstanding_amount: loan.outstanding_amount,
    prior_current_dpd: loan.current_dpd,
    new_emi_amount: input.new_emi_amount,
    new_tenure_months: input.new_tenure_months,
    new_emi_due_dom: input.new_emi_due_dom,
    reason_code: input.reason_code,
  };

  const row = await createDualApprovalRequest({
    tenant_id: input.tenant_id,
    initiator_user_id: input.initiator_user_id,
    action_type: LOAN_RESTRUCTURING_ACTION_TYPE,
    entity_id: input.loan_application_id,
    reason_code: input.reason_code,
    evidence_snapshot,
  });

  return {
    approval_request_id: row.id,
    status: "pending_approval" as const,
    action_type: LOAN_RESTRUCTURING_ACTION_TYPE,
  };
}

/**
 * Post-approval dispatcher for action_type='loan_restructuring'.
 *
 * Reads the just-approved dual_approval_requests row, applies the new EMI
 * fields to nbfc_loans, and inserts one nbfc_loan_restructures row that
 * links back to the approval. Idempotent: if a restructure row already
 * exists for this approval_request_id, it is a no-op.
 */
export async function applyLoanRestructuring(approval_request_id: string) {
  const reqRows = await db
    .select()
    .from(dualApprovalRequests)
    .where(eq(dualApprovalRequests.id, approval_request_id))
    .limit(1);
  if (reqRows.length === 0) {
    throw new Error("NOT_FOUND: approval request not found");
  }
  const req = reqRows[0];
  if (req.action_type !== LOAN_RESTRUCTURING_ACTION_TYPE) {
    throw new Error(
      `BAD_REQUEST: action_type='${req.action_type}' is not loan_restructuring`,
    );
  }
  if (req.status !== "approved") {
    throw new Error(
      `CONFLICT: approval request status is '${req.status}', expected 'approved'`,
    );
  }

  // Idempotency: skip if a restructure row already exists for this approval.
  const existing = await db
    .select({ id: nbfcLoanRestructures.id })
    .from(nbfcLoanRestructures)
    .where(eq(nbfcLoanRestructures.approval_request_id, approval_request_id))
    .limit(1);
  if (existing.length > 0) {
    return { applied: false, reason: "already_applied" };
  }

  const evidence = (req.evidence_snapshot ?? {}) as Record<string, unknown>;
  const new_emi_amount = Number(evidence.new_emi_amount);
  const new_tenure_months = Number(evidence.new_tenure_months);
  const new_emi_due_dom = Number(evidence.new_emi_due_dom);

  if (
    !Number.isFinite(new_emi_amount) ||
    !Number.isFinite(new_tenure_months) ||
    !Number.isFinite(new_emi_due_dom)
  ) {
    throw new Error(
      "BAD_REQUEST: evidence_snapshot is missing new_emi_amount/new_tenure_months/new_emi_due_dom",
    );
  }

  const loanRows = await db
    .select()
    .from(nbfcLoans)
    .where(eq(nbfcLoans.loan_application_id, req.entity_id))
    .limit(1);
  if (loanRows.length === 0) {
    throw new Error("NOT_FOUND: loan_application_id no longer exists");
  }
  const loan = loanRows[0];

  const now = new Date();

  // Update nbfc_loans EMI fields. Tenure is not currently a column on nbfc_loans
  // — it lives in the upstream loan_applications table — so we record it on
  // the restructure history row only.
  await db
    .update(nbfcLoans)
    .set({
      emi_amount: String(new_emi_amount),
      emi_due_date_dom: new_emi_due_dom,
      updated_at: now,
    })
    .where(eq(nbfcLoans.loan_application_id, req.entity_id));

  const [inserted] = await db
    .insert(nbfcLoanRestructures)
    .values({
      tenant_id: req.tenant_id,
      loan_application_id: req.entity_id,
      approval_request_id,
      prior_emi_amount: loan.emi_amount,
      new_emi_amount: String(new_emi_amount),
      prior_tenure_months: null,
      new_tenure_months,
      new_emi_due_dom,
      executed_at: now,
    })
    .returning();

  return { applied: true, restructure_id: inserted.id };
}
