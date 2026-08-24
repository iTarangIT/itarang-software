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
 *
 * The flag is NO LONGER permanent: unflagLoanForRecovery() at the bottom of
 * this file withdraws it while recovery has not physically started. See the
 * comment there for where the reversal stops being allowed.
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { eq, and, isNull, isNotNull, inArray } from "drizzle-orm";
import {
  loanSanctions,
  nbfcBorrowerActions,
  nbfcRecoveryPipeline,
  nbfcBatteryEvaluations,
  recoveryBatteries,
  refurbishmentJobs,
  auctionLotItems,
  auditLogs,
} from "@/lib/db/schema";
import { createRecoveryBattery } from "@/lib/nbfc/recovery/battery";

/**
 * Optional caller-supplied entity context — set when the flag is raised from
 * the lead-intelligence drawer rather than the battery case workspace, so the
 * unified NBFC audit-log feed can resolve the source as a Lead.
 */
export interface FlagForRecoveryContext {
  entity_type: "lead" | "loan";
  lead_id?: string;
  note?: string;
}

export interface FlagForRecoveryInput {
  tenant_id: string;
  loan_sanction_id: string;
  reason: string;
  actor_user_id: string | null;
  /** Optional battery serial to enroll in the recovery pipeline. */
  battery_serial?: string | null;
  context?: FlagForRecoveryContext;
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
      payload: {
        reason: input.reason,
        ...(input.context ? { context: input.context } : {}),
      },
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

    let pipelineId = existingPipeline[0]?.id ?? null;
    if (!pipelineId) {
      const [created] = await db
        .insert(nbfcRecoveryPipeline)
        .values({
          tenant_id: input.tenant_id,
          battery_serial: input.battery_serial,
          stage: "needs_inspection",
          created_at: now,
          updated_at: now,
        })
        .returning({ id: nbfcRecoveryPipeline.id });
      pipelineId = created.id;
    }

    // [E-232] Seed the battery master alongside the workflow row, so the
    // asset exists from the moment recovery is flagged rather than appearing
    // for the first time at intake.
    //
    // ONLY on a real serial. The `else` branch below invents a
    // `LOAN-<uuid>` placeholder to satisfy the pipeline's keying, and writing
    // that into recovery_batteries would put a serial no operator can read off
    // a casing into the asset register — under a GLOBAL unique constraint,
    // permanently. The battery master stays empty until somebody knows which
    // battery this is.
    //
    // Best-effort, like the rest of step 5: a failure here must not undo an
    // approved recovery flag, which is the part of this action that carries
    // the operator's decision.
    try {
      await createRecoveryBattery({
        tenant_id: input.tenant_id,
        serial: input.battery_serial,
        loan_sanction_id: input.loan_sanction_id,
        recovery_pipeline_id: pipelineId,
        recovery_date: flaggedAt.toISOString(),
      });
    } catch (err) {
      console.warn(
        "[flagLoanForRecovery] battery master seed skipped:",
        err instanceof Error ? err.message : err,
      );
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

// ---------------------------------------------------------------------------
// Reversal — "Flag for Recovery" is undoable while nothing has moved
// ---------------------------------------------------------------------------
/**
 * The flag used to be permanent: raising it on the wrong loan left a purple
 * badge, a pipeline row and a battery-master stub with no way back except a
 * hand-written UPDATE. That is a data-entry mistake, not a business decision,
 * and it is the most common one on this screen.
 *
 * So the flag is now reversible — but ONLY while it is still just a flag. The
 * moment recovery actually starts (the battery is inspected, sent to a
 * workshop, moved off `needs_inspection`, or lotted for auction) there are
 * physical facts attached to it, and clearing the flag would orphan them.
 * Those cases stay blocked, with the blocking reason named.
 *
 * Nothing is erased from the audit trail: the original flag_for_recovery row
 * stays in nbfc_borrower_actions and audit_logs forever, and the reversal adds
 * its own `unflag_for_recovery` row carrying the flag it undid.
 */
export interface UnflagForRecoveryInput {
  tenant_id: string;
  loan_sanction_id: string;
  reason: string;
  actor_user_id: string | null;
  /** Same serial the flag was raised with, when the caller knows it. */
  battery_serial?: string | null;
  context?: FlagForRecoveryContext;
}

export interface UnflagForRecoveryResult {
  action_id: string;
  loan_sanction_id: string;
  status: string;
  unflagged_at: string;
  /** Workflow rows withdrawn along with the flag. */
  pipeline_rows_removed: number;
  battery_rows_removed: number;
}

/** Stage past which a reversal is no longer a correction but a rewrite. */
const REVERSIBLE_PIPELINE_STAGE = "needs_inspection";
/**
 * Battery-master states at which nothing physical has been recorded yet.
 *
 * [FIX] This was the single state `"draft"`, and the guard below was therefore
 * unsatisfiable: flagging a loan WITH a battery serial seeds the asset through
 * `createRecoveryBattery`, which writes `intaken`, so the very act of flagging
 * put the battery one state past the only state a withdrawal allowed. Every
 * flag raised with a serial was permanent — silently, and with a message that
 * blamed progress that had not happened. (Checked against the live book at the
 * time of the fix: not one flagged loan had a battery at `draft`.)
 *
 * `intaken` is what the flag itself writes, so it means exactly "nothing has
 * happened here beyond the flag" — which is what this constant is trying to
 * say. The line still holds where it matters: the three guards below refuse a
 * withdrawal once an evaluation exists, a refurbishment job has been raised, or
 * the battery has reached a lot, and any state past `intaken` (`inspected`,
 * `refurbishing`, `ready`, `lotted`, `sold`, `scrapped`) is still refused here.
 */
const REVERSIBLE_BATTERY_STATES = ["draft", "intaken"] as const;

export async function unflagLoanForRecovery(
  input: UnflagForRecoveryInput,
): Promise<UnflagForRecoveryResult> {
  const existing = await db
    .select({
      id: loanSanctions.id,
      nbfc_id: loanSanctions.nbfc_id,
      recovery_flagged_at: loanSanctions.recovery_flagged_at,
      recovery_reason: loanSanctions.recovery_reason,
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

  if (!loan.recovery_flagged_at) {
    throw new Error(
      `CONFLICT: loan ${input.loan_sanction_id} is not flagged for recovery`,
    );
  }
  // Captured before the guards below so the audit payload keeps the flag we
  // are about to clear, not a re-read of an already-nulled column.
  const flaggedAtIso = loan.recovery_flagged_at.toISOString();

  // ---- Collect everything the flag created -------------------------------
  // The flag keys its pipeline row on the battery serial when it has one and
  // on `LOAN-<id>` when it doesn't, so both candidates are checked. The
  // battery master is found by loan id, the link that survives even when the
  // caller has since lost the serial.
  const serialCandidates = [
    input.battery_serial ?? null,
    `LOAN-${input.loan_sanction_id}`,
  ].filter((s): s is string => !!s);

  const batteryRows = await db
    .select({
      id: recoveryBatteries.id,
      serial: recoveryBatteries.serial,
      state_code: recoveryBatteries.state_code,
      recovery_pipeline_id: recoveryBatteries.recovery_pipeline_id,
    })
    .from(recoveryBatteries)
    .where(
      and(
        eq(recoveryBatteries.tenant_id, input.tenant_id),
        eq(recoveryBatteries.loan_sanction_id, input.loan_sanction_id),
      ),
    );

  const pipelineRows = await db
    .select({
      id: nbfcRecoveryPipeline.id,
      battery_serial: nbfcRecoveryPipeline.battery_serial,
      stage: nbfcRecoveryPipeline.stage,
    })
    .from(nbfcRecoveryPipeline)
    .where(
      and(
        eq(nbfcRecoveryPipeline.tenant_id, input.tenant_id),
        inArray(nbfcRecoveryPipeline.battery_serial, serialCandidates),
      ),
    );

  // A battery may point at a pipeline row whose serial has since been
  // corrected, so it would not appear in the serial lookup above. Pull those
  // by id as well — otherwise their stage never gets checked and a recovery
  // already under way could be silently withdrawn.
  const strandedIds = [
    ...new Set(
      batteryRows
        .map((b) => b.recovery_pipeline_id)
        .filter((id): id is string => !!id)
        .filter((id) => !pipelineRows.some((p) => p.id === id)),
    ),
  ];
  const extraPipelineRows = strandedIds.length
    ? await db
        .select({
          id: nbfcRecoveryPipeline.id,
          battery_serial: nbfcRecoveryPipeline.battery_serial,
          stage: nbfcRecoveryPipeline.stage,
        })
        .from(nbfcRecoveryPipeline)
        .where(
          and(
            eq(nbfcRecoveryPipeline.tenant_id, input.tenant_id),
            inArray(nbfcRecoveryPipeline.id, strandedIds),
          ),
        )
    : [];

  const allPipelineRows = [...pipelineRows, ...extraPipelineRows];
  const pipelineIds = new Set<string>(allPipelineRows.map((p) => p.id));
  const batteryIds = batteryRows.map((b) => b.id);

  // ---- Guards: has recovery actually started? ----------------------------
  const movedOn = allPipelineRows.find(
    (p) => p.stage !== REVERSIBLE_PIPELINE_STAGE,
  );
  if (movedOn) {
    throw new Error(
      `CONFLICT: recovery has already progressed to '${movedOn.stage}' for battery ${movedOn.battery_serial}; the flag can no longer be withdrawn`,
    );
  }

  const workedOn = batteryRows.find(
    (b) =>
      !(REVERSIBLE_BATTERY_STATES as readonly string[]).includes(
        b.state_code ?? REVERSIBLE_BATTERY_STATES[0],
      ),
  );
  if (workedOn) {
    throw new Error(
      `CONFLICT: battery ${workedOn.serial} is already '${workedOn.state_code}' in the recovery register; the flag can no longer be withdrawn`,
    );
  }

  if (pipelineIds.size > 0) {
    const evaluated = await db
      .select({ id: nbfcBatteryEvaluations.id })
      .from(nbfcBatteryEvaluations)
      .where(
        inArray(nbfcBatteryEvaluations.recovery_pipeline_id, [...pipelineIds]),
      )
      .limit(1);
    if (evaluated.length > 0) {
      throw new Error(
        "CONFLICT: a battery evaluation has already been recorded for this recovery; the flag can no longer be withdrawn",
      );
    }
  }

  if (batteryIds.length > 0) {
    const refurb = await db
      .select({ id: refurbishmentJobs.id })
      .from(refurbishmentJobs)
      .where(inArray(refurbishmentJobs.battery_id, batteryIds))
      .limit(1);
    if (refurb.length > 0) {
      throw new Error(
        "CONFLICT: a refurbishment job has already been raised for this battery; the flag can no longer be withdrawn",
      );
    }

    const lotted = await db
      .select({ id: auctionLotItems.id })
      .from(auctionLotItems)
      .where(inArray(auctionLotItems.battery_id, batteryIds))
      .limit(1);
    if (lotted.length > 0) {
      throw new Error(
        "CONFLICT: this battery is already part of an auction lot; the flag can no longer be withdrawn",
      );
    }
  }

  // ---- Clear the flag ----------------------------------------------------
  const now = new Date();
  const cleared = await db
    .update(loanSanctions)
    .set({
      recovery_flagged_at: null,
      recovery_reason: null,
      updated_at: now,
    })
    .where(
      and(
        eq(loanSanctions.id, input.loan_sanction_id),
        isNotNull(loanSanctions.recovery_flagged_at),
      ),
    )
    .returning({ id: loanSanctions.id });

  if (cleared.length === 0) {
    // Lost the race — someone else withdrew it a moment ago.
    throw new Error(
      `CONFLICT: loan ${input.loan_sanction_id} is not flagged for recovery`,
    );
  }

  // ---- Withdraw the workflow rows the flag opened ------------------------
  // Best-effort, in the same spirit as step 5 of flagLoanForRecovery: the flag
  // is already cleared and a cleanup failure must not leave the loan flagged.
  // A stranded pipeline row shows up on the Kanban and can be dealt with
  // there; a phantom flag cannot.
  let batteryRowsRemoved = 0;
  let pipelineRowsRemoved = 0;
  try {
    if (batteryIds.length > 0) {
      const deletedBatteries = await db
        .delete(recoveryBatteries)
        .where(
          and(
            eq(recoveryBatteries.tenant_id, input.tenant_id),
            inArray(recoveryBatteries.id, batteryIds),
            // Same widened set as the guard above — otherwise a withdrawal that
            // is now ALLOWED at `intaken` would leave the battery row behind,
            // still pointing at a loan that is no longer flagged.
            inArray(recoveryBatteries.state_code, [...REVERSIBLE_BATTERY_STATES]),
          ),
        )
        .returning({ id: recoveryBatteries.id });
      batteryRowsRemoved = deletedBatteries.length;
    }
    if (pipelineIds.size > 0) {
      const deletedPipeline = await db
        .delete(nbfcRecoveryPipeline)
        .where(
          and(
            eq(nbfcRecoveryPipeline.tenant_id, input.tenant_id),
            inArray(nbfcRecoveryPipeline.id, [...pipelineIds]),
            eq(nbfcRecoveryPipeline.stage, REVERSIBLE_PIPELINE_STAGE),
          ),
        )
        .returning({ id: nbfcRecoveryPipeline.id });
      pipelineRowsRemoved = deletedPipeline.length;
    }
  } catch (err) {
    console.warn(
      "[unflagLoanForRecovery] pipeline cleanup skipped:",
      err instanceof Error ? err.message : err,
    );
  }

  // ---- Audit: the reversal is itself an action, never an erasure ---------
  const reversedFlag = {
    flagged_at: flaggedAtIso,
    reason: loan.recovery_reason ?? null,
  };

  const [actionRow] = await db
    .insert(nbfcBorrowerActions)
    .values({
      tenant_id: input.tenant_id,
      loan_sanction_id: input.loan_sanction_id,
      action_type: "unflag_for_recovery",
      status: "approved",
      requested_by: input.actor_user_id ?? null,
      payload: {
        reason: input.reason,
        reversed_flag: reversedFlag,
        pipeline_rows_removed: pipelineRowsRemoved,
        battery_rows_removed: batteryRowsRemoved,
        ...(input.context ? { context: input.context } : {}),
      },
      created_at: now,
    })
    .returning({ id: nbfcBorrowerActions.id });

  const auditId = `unflag_for_recovery-${actionRow.id}-${randomUUID()}`;
  await db.insert(auditLogs).values({
    id: auditId,
    entity_type: "nbfc_borrower_action",
    entity_id: actionRow.id,
    action: "unflag_for_recovery",
    performed_by: input.actor_user_id ?? null,
    old_data: {
      tenant_id: input.tenant_id,
      loan_sanction_id: input.loan_sanction_id,
      ...reversedFlag,
    },
    new_data: {
      tenant_id: input.tenant_id,
      loan_sanction_id: input.loan_sanction_id,
      reason: input.reason,
      unflagged_at: now.toISOString(),
      pipeline_rows_removed: pipelineRowsRemoved,
      battery_rows_removed: batteryRowsRemoved,
    },
  });

  return {
    action_id: actionRow.id,
    loan_sanction_id: input.loan_sanction_id,
    status: "approved",
    unflagged_at: now.toISOString(),
    pipeline_rows_removed: pipelineRowsRemoved,
    battery_rows_removed: batteryRowsRemoved,
  };
}
