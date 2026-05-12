/**
 * E-086 — Bulk Immobilisation (>5 batteries) gated by dual approval.
 *
 * BRD §6.4.3: Approver 1 = NBFC Risk Head, Approver 2 = iTarang Admin.
 * Threshold: batch_size > 5 (Zod min(6) at the API surface). Per-loan rows
 * (≤5 batteries) follow the standard per-loan path (E-033).
 *
 * Flow:
 *   1. initiateBulkImmobilisation()
 *      a. Snapshot per-loan evidence (DPD, outstanding, last EMI status).
 *      b. Insert nbfc_bulk_immobilisation_batches row keyed by a fresh batch_id.
 *      c. Create dual_approval_requests row with action_type='bulk_immobilisation'
 *         and entity_id=batch_id.
 *      d. Persist the dual_approval_requests.id back onto the batch row so the
 *         approve hook can find the batch.
 *   2. On dual_approval_requests.status='approved' (E-082 approve route),
 *      executeApprovedBulkImmobilisation() is invoked. It enqueues per-loan
 *      immobilisation rows in nbfc_borrower_actions and stamps the batch row
 *      with executed_at + executed_count.
 */
import { db } from "@/lib/db";
import { eq, and, inArray } from "drizzle-orm";
import {
  nbfcBulkImmobilisationBatches,
  nbfcBorrowerActions,
  nbfcLoans,
  dualApprovalRequests,
} from "@/lib/db/schema";
import { createDualApprovalRequest } from "@/lib/nbfc/dual-approval/service";

export interface InitiateBulkInput {
  tenant_id: string;
  initiator_user_id: string;
  loan_application_ids: string[];
  reason_code: "portfolio_dpd_sweep" | "fraud_cluster" | "manual";
}

export interface InitiateBulkOutput {
  approval_request_id: string;
  batch_id: string;
  status: "pending_approval";
  action_type: "bulk_immobilisation";
  batch_size: number;
}

/**
 * Snapshot per-loan evidence (DPD / outstanding / last_emi_status) for the
 * approver to review. Loans not present in nbfc_loans are still recorded with
 * `not_found=true` so the snapshot is exhaustive. Tenant-scoped lookup so a
 * Risk Head from one tenant cannot snapshot another tenant's loans.
 */
async function snapshotLoanEvidence(
  tenant_id: string,
  loan_application_ids: string[],
) {
  const rows = await db
    .select({
      loan_application_id: nbfcLoans.loan_application_id,
      tenant_id: nbfcLoans.tenant_id,
      current_dpd: nbfcLoans.current_dpd,
      outstanding_amount: nbfcLoans.outstanding_amount,
    })
    .from(nbfcLoans)
    .where(
      and(
        eq(nbfcLoans.tenant_id, tenant_id),
        inArray(nbfcLoans.loan_application_id, loan_application_ids),
      ),
    );
  const byId = new Map(rows.map((r) => [r.loan_application_id, r]));
  return loan_application_ids.map((id) => {
    const row = byId.get(id);
    if (!row) {
      return { loan_application_id: id, not_found: true };
    }
    return {
      loan_application_id: id,
      current_dpd: row.current_dpd,
      outstanding_amount: row.outstanding_amount,
      last_emi_status: row.current_dpd === 0 ? "current" : "overdue",
    };
  });
}

export async function initiateBulkImmobilisation(
  input: InitiateBulkInput,
): Promise<InitiateBulkOutput> {
  const ids = Array.from(new Set(input.loan_application_ids));
  if (ids.length <= 5) {
    throw new Error(
      `BAD_REQUEST: bulk immobilisation requires more than 5 loan_application_ids; got ${ids.length}`,
    );
  }

  const evidence = await snapshotLoanEvidence(input.tenant_id, ids);

  // Create the batch row first so the approval request entity_id can point to it.
  const [batch] = await db
    .insert(nbfcBulkImmobilisationBatches)
    .values({
      tenant_id: input.tenant_id,
      approval_request_id: "00000000-0000-0000-0000-000000000000",
      batch_size: ids.length,
      loan_application_ids: ids as unknown as object,
      executed_count: 0,
    })
    .returning();

  const approval = await createDualApprovalRequest({
    tenant_id: input.tenant_id,
    initiator_user_id: input.initiator_user_id,
    action_type: "bulk_immobilisation",
    entity_id: batch.id,
    reason_code: input.reason_code,
    evidence_snapshot: {
      batch_id: batch.id,
      batch_size: ids.length,
      loan_application_ids: ids,
      per_loan: evidence,
    },
  });

  // Stamp the approval id back on the batch so the approve handler can find it.
  await db
    .update(nbfcBulkImmobilisationBatches)
    .set({ approval_request_id: approval.id })
    .where(eq(nbfcBulkImmobilisationBatches.id, batch.id));

  return {
    approval_request_id: approval.id,
    batch_id: batch.id,
    status: "pending_approval",
    action_type: "bulk_immobilisation",
    batch_size: ids.length,
  };
}

/**
 * Execute a bulk immobilisation that has just been approved. Idempotent: if
 * the batch already has executed_at set, returns existing batch unchanged.
 *
 * Writes one row per loan into nbfc_borrower_actions with
 *   action_type='battery_immobilisation', status='executed' so per-loan auditing
 * stays uniform with E-033's single-loan path. Then stamps the batch with
 * executed_at and executed_count.
 */
export async function executeApprovedBulkImmobilisation(approval_request_id: string) {
  const [batch] = await db
    .select()
    .from(nbfcBulkImmobilisationBatches)
    .where(
      eq(nbfcBulkImmobilisationBatches.approval_request_id, approval_request_id),
    )
    .limit(1);

  if (!batch) {
    // No batch is OK — this hook is fired for every approval; only bulk runs.
    return null;
  }
  if (batch.executed_at) {
    return batch; // idempotent
  }

  const ids = Array.isArray(batch.loan_application_ids)
    ? (batch.loan_application_ids as string[])
    : [];

  // Find approval row to link initiator into per-loan rows for traceability.
  const [approval] = await db
    .select()
    .from(dualApprovalRequests)
    .where(eq(dualApprovalRequests.id, approval_request_id))
    .limit(1);

  if (ids.length > 0) {
    await db.insert(nbfcBorrowerActions).values(
      ids.map((loan_id) => ({
        tenant_id: batch.tenant_id,
        loan_sanction_id: loan_id,
        action_type: "battery_immobilisation",
        status: "executed",
        requested_by: approval?.initiator_user_id ?? null,
        payload: {
          source: "bulk_immobilisation",
          approval_request_id,
          batch_id: batch.id,
        },
      })),
    );
  }

  const now = new Date();
  const [updated] = await db
    .update(nbfcBulkImmobilisationBatches)
    .set({ executed_at: now, executed_count: ids.length })
    .where(eq(nbfcBulkImmobilisationBatches.id, batch.id))
    .returning();
  return updated;
}
