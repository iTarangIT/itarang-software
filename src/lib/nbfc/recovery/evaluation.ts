/**
 * E-037 — Battery Evaluation 3-step form service (BRD §6.1.7).
 *
 * Persists an evaluation row into nbfc_battery_evaluations and bumps the
 * linked nbfc_recovery_pipeline row's stage. The base auction price is
 * computed deterministically from the SOH and step3.original_value. The
 * BRD specifies ranges (e.g. >85% SOH = 65–70%); E-037 fixes deterministic
 * pivots inside each range so the unit is testable:
 *
 *   - reject true OR (soh < 70 AND step2.decision='scrap') -> rejected, price=0
 *   - soh > 85                                              -> 0.675 * original
 *   - soh >= 70 (i.e. 70..85 inclusive at 70)               -> 0.575 * original
 *   - soh < 70  (not scrap)                                 -> 0.40  * original
 *
 * Tenant scoping enforced explicitly in every where-clause.
 *
 * [E-233] The PRICE BANDS above are unchanged. What changed is what an
 * evaluation *does*:
 *
 *   - It grades the battery (new | refurbished | partial_working, BRD §6) from
 *     the single set of SOH bands in stages.ts, and stores that grade.
 *   - The SOH floor now overrides the operator's decision. Scrap previously
 *     required BOTH `soh < 70` AND an explicit `decision='scrap'`, so a
 *     mis-clicked "minor repair" on a 20% cell sent it to auction. Below
 *     SOH_SCRAP_BELOW it is scrap regardless of what the form says.
 *   - A battery between the scrap floor and the refurbishment threshold goes
 *     STRAIGHT to ready_for_auction as partial_working, rather than into a
 *     workshop queue with no work to do.
 *   - The insert and the stage update run in ONE transaction. They were two
 *     unguarded statements, so a failure between them left an evaluation
 *     recorded against a battery still sitting in needs_inspection.
 */
import { db } from "@/lib/db";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import {
  nbfcBatteryEvaluations,
  nbfcRecoveryPipeline,
  recoveryBatteries,
} from "@/lib/db/schema";
import { gradeForSoh, type ConditionGrade } from "@/lib/nbfc/recovery/stages";

/**
 * How long an identical resubmission of the same pipeline row is treated as a
 * retry of the first one rather than a second evaluation.
 *
 * The client retries a POST whose response never arrived (see
 * BatteryEvaluationWizard.postEvaluation), and an impatient double-click does
 * the same thing by hand. Both replay the exact same three steps within
 * seconds; a genuine re-evaluation is a person re-inspecting a battery, which
 * neither happens inside a minute nor produces byte-identical readings.
 */
const RESUBMIT_WINDOW_MS = 60_000;

export interface Step1 {
  soh_percent: number;
  physical_condition: "good" | "fair" | "poor";
  manufacturing_date: string;
  iot_status: "online" | "offline";
  bms_health: "healthy" | "degraded" | "failed";
  charger_type: string;
}

export interface Step2 {
  decision: "minor_repair" | "cell_replacement" | "scrap";
  estimated_cost: number;
  checklist: {
    terminal_cleaning: boolean;
    software_recalibration: boolean;
    warranty_reset: boolean;
  };
}

export interface Step3 {
  original_value: number;
  reject?: boolean;
}

export interface EvaluationInput {
  tenant_id: string;
  recovery_pipeline_id: string;
  step1: Step1;
  step2: Step2;
  step3: Step3;
  /**
   * [E-233] Relative /api/files paths for the shots taken at this inspection
   * (BRD §20). Captured once here and reused verbatim as the auction images.
   */
  photo_urls?: string[];
}

export interface EvaluationResult {
  evaluation_id: string;
  base_auction_price: number;
  rejected: boolean;
  /** [E-233] null when the battery graded as scrap. */
  condition_grade: ConditionGrade | null;
  /** [E-233] The stage this evaluation moved the pipeline row to. */
  stage: string;
}

/**
 * Compute the base auction price + rejected flag from the three steps.
 * Pure function; exported for unit-style tests if needed.
 */
export function computeBasePrice(input: {
  soh: number;
  decision: Step2["decision"];
  reject?: boolean;
  original_value: number;
}): { base_auction_price: number; rejected: boolean } {
  const { soh, decision, reject, original_value } = input;

  if (reject === true || (soh < 70 && decision === "scrap")) {
    return { base_auction_price: 0, rejected: true };
  }

  let factor: number;
  if (soh > 85) {
    factor = 0.675;
  } else if (soh >= 70) {
    factor = 0.575;
  } else {
    factor = 0.4;
  }

  // Round to 2 decimals to match numeric(12,2)
  const raw = factor * original_value;
  const base_auction_price = Math.round(raw * 100) / 100;
  return { base_auction_price, rejected: false };
}

/**
 * Persist an evaluation. Asserts tenant ownership of the pipeline row.
 * Updates the pipeline row's stage based on step2.decision.
 *
 * Throws structured Error messages whose prefix encodes HTTP status:
 *   - NOT_FOUND: pipeline row missing or owned by another tenant
 */
export async function recordEvaluation(
  input: EvaluationInput,
): Promise<EvaluationResult> {
  // 1. Resolve pipeline row + tenant ownership.
  const pipelineRows = await db
    .select({
      id: nbfcRecoveryPipeline.id,
      tenant_id: nbfcRecoveryPipeline.tenant_id,
      battery_id: nbfcRecoveryPipeline.battery_id,
    })
    .from(nbfcRecoveryPipeline)
    .where(
      and(
        eq(nbfcRecoveryPipeline.id, input.recovery_pipeline_id),
        eq(nbfcRecoveryPipeline.tenant_id, input.tenant_id),
      ),
    )
    .limit(1);

  if (pipelineRows.length === 0) {
    throw new Error(
      "NOT_FOUND: recovery pipeline row not found for this tenant",
    );
  }

  // 2. Compute price.
  const { base_auction_price, rejected } = computeBasePrice({
    soh: input.step1.soh_percent,
    decision: input.step2.decision,
    reject: input.step3.reject,
    original_value: input.step3.original_value,
  });

  // [E-233] The grade the auction sells on (BRD §6), from the one set of SOH
  // bands in stages.ts. Stored rather than recomputed at read time: the bands
  // may be retuned later, and a battery already advertised as partial_working
  // must not silently re-grade itself under a lot that is mid-auction.
  const sohGrade = gradeForSoh(input.step1.soh_percent);

  // [E-233] The stage this evaluation lands the battery on.
  //
  // The operator's decision no longer has the last word on scrap. A battery
  // below the SOH floor is scrap whatever the form says — the previous rule
  // needed BOTH `soh < 70` AND an explicit `decision === 'scrap'`, so a
  // mis-clicked "minor repair" on a 20% cell sent it to auction.
  const nextStage =
    sohGrade === "scrap" || input.step2.decision === "scrap" || rejected
      ? "scrap"
      : sohGrade === "partial_working"
        ? // Below the refurbishment threshold but above the scrap floor: there
          // is nothing a workshop is being asked to do, so it goes straight to
          // auction as partial_working rather than into a job queue it would
          // sit in forever.
          "ready_for_auction"
        : "refurbishable";

  // [E-233] One transaction. These were two unguarded statements, so a failure
  // between them left an evaluation recorded against a battery still sitting in
  // needs_inspection — the row said the inspection had happened and the board
  // said it had not.
  const evalRow = await db.transaction(async (tx) => {
    // Idempotency for a replayed submit. Keyed on the payload itself rather
    // than on a client-supplied token: no column had to be added, and the
    // question being asked ("did this exact evaluation just land?") is the one
    // that matters. jsonb equality is key-order independent, so it does not
    // depend on how the client serialised the object.
    const [replay] = await tx
      .select({ id: nbfcBatteryEvaluations.id })
      .from(nbfcBatteryEvaluations)
      .where(
        and(
          eq(nbfcBatteryEvaluations.tenant_id, input.tenant_id),
          eq(
            nbfcBatteryEvaluations.recovery_pipeline_id,
            input.recovery_pipeline_id,
          ),
          gt(
            nbfcBatteryEvaluations.created_at,
            new Date(Date.now() - RESUBMIT_WINDOW_MS),
          ),
          sql`${nbfcBatteryEvaluations.step1} = ${JSON.stringify(input.step1)}::jsonb`,
          sql`${nbfcBatteryEvaluations.step2} = ${JSON.stringify(input.step2)}::jsonb`,
          sql`${nbfcBatteryEvaluations.step3} = ${JSON.stringify(input.step3)}::jsonb`,
        ),
      )
      .orderBy(desc(nbfcBatteryEvaluations.created_at))
      .limit(1);

    // The first attempt committed everything below — stage and battery master
    // included — so returning its id is the whole of the work. Every value in
    // the result is derived from the same input, so it reads back identical.
    if (replay) return replay;

    const [created] = await tx
      .insert(nbfcBatteryEvaluations)
      .values({
        tenant_id: input.tenant_id,
        recovery_pipeline_id: input.recovery_pipeline_id,
        step1: input.step1 as unknown as Record<string, unknown>,
        step2: input.step2 as unknown as Record<string, unknown>,
        step3: input.step3 as unknown as Record<string, unknown>,
        base_auction_price: base_auction_price.toFixed(2),
        rejected,
        condition_grade: sohGrade === "scrap" ? null : sohGrade,
        ...(input.photo_urls ? { photo_urls: input.photo_urls } : {}),
      })
      .returning({ id: nbfcBatteryEvaluations.id });

    await tx
      .update(nbfcRecoveryPipeline)
      .set({ stage: nextStage, updated_at: new Date() })
      .where(
        and(
          eq(nbfcRecoveryPipeline.id, input.recovery_pipeline_id),
          eq(nbfcRecoveryPipeline.tenant_id, input.tenant_id),
        ),
      );

    // Keep the battery master in step with the workflow row. The battery is
    // what the auction lists, so a grade recorded only on the evaluation would
    // never reach a lot item.
    const batteryId = pipelineRows[0].battery_id;
    if (batteryId) {
      await tx
        .update(recoveryBatteries)
        .set({
          state_code:
            nextStage === "scrap"
              ? "scrapped"
              : nextStage === "ready_for_auction"
                ? "ready"
                : "inspected",
          condition_grade: sohGrade === "scrap" ? null : sohGrade,
          updated_at: new Date(),
        })
        .where(eq(recoveryBatteries.id, batteryId));
    }

    return created;
  });

  return {
    evaluation_id: evalRow.id,
    base_auction_price,
    rejected,
    condition_grade: sohGrade === "scrap" ? null : sohGrade,
    stage: nextStage,
  };
}
