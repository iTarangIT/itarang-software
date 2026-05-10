/**
 * E-032 — Request Field Visit (BRD §6.1.6)
 *
 * Pure DB service. The HTTP routes (initiate + cancel) hand off to the two
 * functions exported here once the tenant + actor have been resolved by
 * `resolveActor()`.
 *
 * BRD §6.1.6 row "Request Field Visit": single approval (NBFC Manager),
 * reversible=Yes, audit-logged with a manual reason.
 *
 * Behavior (per unit YAML logic):
 *   1. Validate request and assert caller has `nbfc_manager` role or above
 *      (route-level).
 *   2. Insert nbfc_borrower_actions row
 *      (action_type='field_visit', status='approved', payload.reason=reason).
 *   3. Insert nbfc_audit_log row carrying the reason in after_state.
 *   4. The cancel endpoint flips status to 'reversed' and writes another
 *      audit_log row capturing the cancellation reason.
 *
 * Cross-tenant isolation: the loan must belong to the calling tenant
 * (loanSanctions.nbfc_id === tenant_id) — same pattern as E-031 / E-035.
 */
import { db } from "@/lib/db";
import { and, eq } from "drizzle-orm";
import {
  loanSanctions,
  nbfcAuditLog,
  nbfcBorrowerActions,
} from "@/lib/db/schema";

export interface RequestFieldVisitInput {
  tenant_id: string;
  loan_sanction_id: string;
  reason: string;
  actor_user_id: string;
}

export interface RequestFieldVisitResult {
  action_id: string;
  status: string;
  created_at: string;
}

export async function requestFieldVisit(
  input: RequestFieldVisitInput,
): Promise<RequestFieldVisitResult> {
  // Cross-tenant scoping check.
  const loanRows = await db
    .select({
      id: loanSanctions.id,
      nbfc_id: loanSanctions.nbfc_id,
    })
    .from(loanSanctions)
    .where(eq(loanSanctions.id, input.loan_sanction_id))
    .limit(1);

  if (loanRows.length === 0) {
    throw new Error("NOT_FOUND: loan_sanction not found");
  }
  const loan = loanRows[0];
  if (loan.nbfc_id && loan.nbfc_id !== input.tenant_id) {
    throw new Error("FORBIDDEN: loan_sanction belongs to a different tenant");
  }
  if (!loan.nbfc_id) {
    throw new Error("FORBIDDEN: loan_sanction has no tenant binding");
  }

  const now = new Date();

  // Insert the borrower-actions row at status='approved' (single-approval per
  // BRD §6.1.6 Request Field Visit row).
  const [actionRow] = await db
    .insert(nbfcBorrowerActions)
    .values({
      tenant_id: input.tenant_id,
      loan_sanction_id: input.loan_sanction_id,
      action_type: "field_visit",
      status: "approved",
      requested_by: input.actor_user_id,
      payload: { reason: input.reason },
      created_at: now,
    })
    .returning({
      id: nbfcBorrowerActions.id,
      status: nbfcBorrowerActions.status,
      created_at: nbfcBorrowerActions.created_at,
    });

  // Immutable audit-log row referencing the action_id.
  await db.insert(nbfcAuditLog).values({
    tenant_id: input.tenant_id,
    user_id: input.actor_user_id,
    action_type: "field_visit",
    action_id: actionRow.id,
    before_state: {
      loan_sanction_id: input.loan_sanction_id,
      field_visit_requested: false,
    },
    after_state: {
      loan_sanction_id: input.loan_sanction_id,
      field_visit_requested: true,
      reason: input.reason,
      action_id: actionRow.id,
    },
    created_at: now,
  });

  return {
    action_id: actionRow.id,
    status: actionRow.status,
    created_at: (actionRow.created_at ?? now).toISOString(),
  };
}

export interface CancelFieldVisitInput {
  tenant_id: string;
  action_id: string;
  reason: string;
  actor_user_id: string;
}

export interface CancelFieldVisitResult {
  action_id: string;
  status: string;
}

export async function cancelFieldVisit(
  input: CancelFieldVisitInput,
): Promise<CancelFieldVisitResult> {
  // Look up the action row, scoped to tenant.
  const rows = await db
    .select({
      id: nbfcBorrowerActions.id,
      tenant_id: nbfcBorrowerActions.tenant_id,
      action_type: nbfcBorrowerActions.action_type,
      status: nbfcBorrowerActions.status,
      loan_sanction_id: nbfcBorrowerActions.loan_sanction_id,
    })
    .from(nbfcBorrowerActions)
    .where(eq(nbfcBorrowerActions.id, input.action_id))
    .limit(1);

  if (rows.length === 0) {
    throw new Error("NOT_FOUND: action not found");
  }
  const action = rows[0];

  if (action.tenant_id !== input.tenant_id) {
    throw new Error("FORBIDDEN: action belongs to a different tenant");
  }
  if (action.action_type !== "field_visit") {
    throw new Error(
      `BAD_REQUEST: action ${input.action_id} is not a field_visit`,
    );
  }
  if (action.status === "reversed") {
    throw new Error(
      `CONFLICT: action ${input.action_id} is already reversed`,
    );
  }

  const now = new Date();

  // Atomic-ish update — only flip the row if it is still approved (i.e., not
  // already reversed by a concurrent caller).
  const updated = await db
    .update(nbfcBorrowerActions)
    .set({ status: "reversed" })
    .where(
      and(
        eq(nbfcBorrowerActions.id, input.action_id),
        eq(nbfcBorrowerActions.status, action.status),
      ),
    )
    .returning({ id: nbfcBorrowerActions.id, status: nbfcBorrowerActions.status });

  if (updated.length === 0) {
    throw new Error(
      `CONFLICT: action ${input.action_id} status changed concurrently`,
    );
  }

  // Audit-log the cancellation.
  await db.insert(nbfcAuditLog).values({
    tenant_id: input.tenant_id,
    user_id: input.actor_user_id,
    action_type: "field_visit_cancel",
    action_id: input.action_id,
    before_state: {
      loan_sanction_id: action.loan_sanction_id,
      status: action.status,
    },
    after_state: {
      loan_sanction_id: action.loan_sanction_id,
      status: "reversed",
      cancellation_reason: input.reason,
      action_id: input.action_id,
    },
    created_at: now,
  });

  return {
    action_id: input.action_id,
    status: "reversed",
  };
}
