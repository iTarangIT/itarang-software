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
 */
import { db } from "@/lib/db";
import { and, eq } from "drizzle-orm";
import { nbfcBatteryEvaluations, nbfcRecoveryPipeline } from "@/lib/db/schema";

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
}

export interface EvaluationResult {
  evaluation_id: string;
  base_auction_price: number;
  rejected: boolean;
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

  // 3. Insert evaluation row.
  const [evalRow] = await db
    .insert(nbfcBatteryEvaluations)
    .values({
      tenant_id: input.tenant_id,
      recovery_pipeline_id: input.recovery_pipeline_id,
      step1: input.step1 as unknown as Record<string, unknown>,
      step2: input.step2 as unknown as Record<string, unknown>,
      step3: input.step3 as unknown as Record<string, unknown>,
      base_auction_price: base_auction_price.toFixed(2),
      rejected,
    })
    .returning({ id: nbfcBatteryEvaluations.id });

  // 4. Update pipeline stage.
  const nextStage =
    input.step2.decision === "scrap" ? "scrap" : "refurbishable";

  await db
    .update(nbfcRecoveryPipeline)
    .set({ stage: nextStage, updated_at: new Date() })
    .where(
      and(
        eq(nbfcRecoveryPipeline.id, input.recovery_pipeline_id),
        eq(nbfcRecoveryPipeline.tenant_id, input.tenant_id),
      ),
    );

  return {
    evaluation_id: evalRow.id,
    base_auction_price,
    rejected,
  };
}
