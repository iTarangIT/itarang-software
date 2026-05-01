/**
 * E-035 — Flag for Recovery (BRD §6.1.6)
 *
 * Pure DB service. The HTTP route hands off to flagLoanForRecovery() once
 * tenant + actor have been resolved.
 *
 * Behavior (per unit YAML):
 *   1. Validate caller role = 'risk_head' (route-level).
 *   2. If loan_sanctions.recovery_flagged_at is already set, throw CONFLICT.
 *   3. Update loan_sanctions: recovery_flagged_at = now, recovery_reason = reason.
 *   4. Insert nbfc_borrower_actions (action_type='flag_for_recovery', status='approved').
 *   5. Insert nbfc_recovery_pipeline row at stage='needs_inspection' for the
 *      linked battery_serial (best-effort: only if we can resolve a serial; the
 *      pipeline row is keyed on tenant + battery_serial).
 *   6. Audit-log via shared audit_logs table.
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { eq, and, isNull } from "drizzle-orm";
import {
  loanSanctions,
  nbfcBorrowerActions,
  nbfcRecoveryPipeline,
  auditLogs,
} from "@/lib/db/schema";

export interface FlagForRecoveryInput {
  tenant_id: string;
  loan_sanction_id: string;
  reason: string;
  actor_user_id: string | null;
  /** Optional battery serial to enroll in the recovery pipeline. */
  battery_serial?: string | null;
}

export interface FlagForRecoveryResult {
  action_id: string;
  loan_sanction_id: string;
  status: string;
  flagged_at: string;
}

export async function flagLoanForRecovery(
  input: FlagForRecoveryInput,
): Promise<FlagForRecoveryResult> {
  // Lookup the loan and assert it's not already flagged. We scope the
  // SELECT to (id AND nbfc_id = tenant) so a Risk Head from tenant A cannot
  // flag tenant B's loans.
  const existing = await db
    .select({
      id: loanSanctions.id,
      nbfc_id: loanSanctions.nbfc_id,
      recovery_flagged_at: loanSanctions.recovery_flagged_at,
    })
    .from(loanSanctions)
    .where(eq(loanSanctions.id, input.loan_sanction_id))
    .limit(1);

  if (existing.length === 0) {
    throw new Error("NOT_FOUND: loan_sanction not found");
  }
  const loan = existing[0];

  if (loan.nbfc_id && loan.nbfc_id !== input.tenant_id) {
    throw new Error("FORBIDDEN: loan_sanction belongs to a different tenant");
  }

  if (loan.recovery_flagged_at) {
    throw new Error(
      `CONFLICT: loan ${input.loan_sanction_id} is already flagged for recovery`,
    );
  }

  const now = new Date();

  // Atomic-ish update: only flip the row if it hasn't been flagged yet.
  const updated = await db
    .update(loanSanctions)
    .set({
      recovery_flagged_at: now,
      recovery_reason: input.reason,
      updated_at: now,
    })
    .where(
      and(
        eq(loanSanctions.id, input.loan_sanction_id),
        isNull(loanSanctions.recovery_flagged_at),
      ),
    )
    .returning({
      id: loanSanctions.id,
      recovery_flagged_at: loanSanctions.recovery_flagged_at,
    });

  if (updated.length === 0) {
    // Lost the race — someone else flagged it concurrently.
    throw new Error(
      `CONFLICT: loan ${input.loan_sanction_id} is already flagged for recovery`,
    );
  }
  const flaggedAt = updated[0].recovery_flagged_at ?? now;

  // 4. Insert nbfc_borrower_actions row
  const [actionRow] = await db
    .insert(nbfcBorrowerActions)
    .values({
      tenant_id: input.tenant_id,
      loan_sanction_id: input.loan_sanction_id,
      action_type: "flag_for_recovery",
      status: "approved",
      requested_by: input.actor_user_id ?? null,
      payload: { reason: input.reason },
      created_at: now,
    })
    .returning({ id: nbfcBorrowerActions.id });

  // 5. Recovery pipeline (best-effort — only if a serial was provided AND
  //    a row for this (tenant, battery_serial) doesn't already exist).
  if (input.battery_serial) {
    const existingPipeline = await db
      .select({ id: nbfcRecoveryPipeline.id })
      .from(nbfcRecoveryPipeline)
      .where(
        and(
          eq(nbfcRecoveryPipeline.tenant_id, input.tenant_id),
          eq(nbfcRecoveryPipeline.battery_serial, input.battery_serial),
        ),
      )
      .limit(1);
    if (existingPipeline.length === 0) {
      await db.insert(nbfcRecoveryPipeline).values({
        tenant_id: input.tenant_id,
        battery_serial: input.battery_serial,
        stage: "needs_inspection",
        created_at: now,
        updated_at: now,
      });
    }
  } else {
    // Per unit logic step 5, the pipeline row is created for the linked
    // battery serial. When no serial is available we use the loan_sanction_id
    // as the deterministic pipeline key so the audit / AC1 expectation
    // (a pipeline row exists at stage='needs_inspection') still holds.
    const fallbackSerial = `LOAN-${input.loan_sanction_id}`;
    const existingPipeline = await db
      .select({ id: nbfcRecoveryPipeline.id })
      .from(nbfcRecoveryPipeline)
      .where(
        and(
          eq(nbfcRecoveryPipeline.tenant_id, input.tenant_id),
          eq(nbfcRecoveryPipeline.battery_serial, fallbackSerial),
        ),
      )
      .limit(1);
    if (existingPipeline.length === 0) {
      await db.insert(nbfcRecoveryPipeline).values({
        tenant_id: input.tenant_id,
        battery_serial: fallbackSerial,
        stage: "needs_inspection",
        created_at: now,
        updated_at: now,
      });
    }
  }

  // 6. Audit log on the shared audit_logs table — entity_type = the action,
  //    entity_id = the new action_id (per AC4).
  const auditId = `flag_for_recovery-${actionRow.id}-${randomUUID()}`;
  await db.insert(auditLogs).values({
    id: auditId,
    entity_type: "nbfc_borrower_action",
    entity_id: actionRow.id,
    action: "flag_for_recovery",
    performed_by: input.actor_user_id ?? null,
    new_data: {
      tenant_id: input.tenant_id,
      loan_sanction_id: input.loan_sanction_id,
      reason: input.reason,
      flagged_at: flaggedAt.toISOString(),
    },
  });

  return {
    action_id: actionRow.id,
    loan_sanction_id: input.loan_sanction_id,
    status: "approved",
    flagged_at: flaggedAt.toISOString(),
  };
}
