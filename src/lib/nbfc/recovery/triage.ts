/**
 * E-292 — Recovery triage (refurbish flow v3, steps R1–R3).
 *
 * The gate BEFORE refurbishment. The NBFC records the pack's rated and
 * measured voltage (plus condition, note, photos); health % = measured ÷
 * rated; the system SUGGESTS one of three branches and the NBFC CLICKS one.
 * Refurbishment is optional — the only hard rule is that a battery under the
 * 70% floor cannot be refurbished ("not suitable for refurbishing").
 *
 * The design's worked example is a 51 V pack (> 40 V fit as-is · 35–40 V
 * refurbish · < 35 V scrap); the thresholds here are RATIOS of that example so
 * a 48 V or 60 V pack is judged the same way.
 *
 * `health_pct` also stands in for the SOH wherever no 3-step evaluation exists
 * (refurbishment-lots.ts, stages.ts), so a triaged battery can be sent for
 * refurbishment without the wizard. An evaluation, when present, still wins —
 * it is the measured figure.
 */
import { db } from "@/lib/db";
import { and, eq } from "drizzle-orm";
import { nbfcAuditLog, nbfcRecoveryPipeline, recoveryBatteries } from "@/lib/db/schema";
import { attachBatteryPhotos, getBattery, type BatteryRow } from "@/lib/nbfc/recovery/battery";
import { transitionStage, type TransitionResult } from "@/lib/nbfc/recovery/stages";
import {
  TRIAGE_REFURB_MIN_PCT,
  allowedChoices,
  healthPct,
  suggestTriage,
  type TriageChoice,
  type TriageCondition,
  type TriageSuggestion,
} from "@/lib/nbfc/recovery/triage-rules";

export {
  TRIAGE_FIT_MIN_PCT,
  TRIAGE_REFURB_MIN_PCT,
  TRIAGE_SUGGESTIONS,
  TRIAGE_CHOICES,
  TRIAGE_CONDITIONS,
  TRIAGE_SUGGESTION_LABEL,
  TRIAGE_CHOICE_LABEL,
  healthPct,
  suggestTriage,
  allowedChoices,
  type TriageSuggestion,
  type TriageChoice,
  type TriageCondition,
} from "@/lib/nbfc/recovery/triage-rules";

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------
export interface RecordTriageInput {
  tenant_id: string;
  actor_user_id: string;
  battery_id: string;
  rated_voltage_v: number;
  measured_voltage_v: number;
  condition?: TriageCondition | null;
  note?: string | null;
  /** Relative /api/files paths already uploaded via the battery photo route. */
  photo_paths?: string[];
}

export interface TriageView {
  battery: BatteryRow;
  health_pct: number | null;
  suggestion: TriageSuggestion | null;
  allowed_choices: TriageChoice[];
}

function view(battery: BatteryRow): TriageView {
  const health = battery.health_pct;
  return { battery, health_pct: health, suggestion: suggestTriage(health), allowed_choices: allowedChoices(health) };
}

/** R2: recovery details. Sets state_code=inspected on a draft/intaken battery so it is lot-eligible. */
export async function recordTriage(input: RecordTriageInput): Promise<TriageView> {
  const existing = await getBattery(input.tenant_id, input.battery_id);
  if (!existing) throw new Error("NOT_FOUND: battery not found");
  if (["lotted", "sold", "scrapped"].includes(existing.state_code)) {
    throw new Error(`CONFLICT: battery is ${existing.state_code} — triage is over`);
  }
  if (existing.state_code === "refurbishing") {
    throw new Error("CONFLICT: battery is in a refurbishment lot — triage is over");
  }
  if (!(input.rated_voltage_v > 0) || !(input.measured_voltage_v >= 0)) {
    throw new Error("BAD_REQUEST: rated voltage must be positive and measured voltage non-negative");
  }
  const health = healthPct(input.measured_voltage_v, input.rated_voltage_v);
  if (health == null) throw new Error("BAD_REQUEST: could not compute health from those voltages");
  const suggestion = suggestTriage(health);
  const now = new Date();

  await db.transaction(async (tx) => {
    await tx
      .update(recoveryBatteries)
      .set({
        rated_voltage_v: String(input.rated_voltage_v),
        measured_voltage_v: String(input.measured_voltage_v),
        health_pct: String(health),
        triage_condition: input.condition ?? null,
        triage_note: input.note ?? null,
        triage_suggestion: suggestion,
        triaged_at: now,
        triaged_by: input.actor_user_id,
        // The register calls a battery with recovery details "inspected"; a
        // triaged battery must be eligible for a refurbishment lot.
        ...(existing.state_code === "draft" || existing.state_code === "intaken" ? { state_code: "inspected" } : {}),
        updated_at: now,
      })
      .where(and(eq(recoveryBatteries.id, input.battery_id), eq(recoveryBatteries.tenant_id, input.tenant_id)));
    if (input.photo_paths?.length) {
      await attachBatteryPhotos(input.tenant_id, input.battery_id, input.photo_paths, tx);
    }
    await tx.insert(nbfcAuditLog).values({
      tenant_id: input.tenant_id,
      user_id: input.actor_user_id,
      action_type: "recovery_triaged",
      action_id: input.battery_id,
      before_state: { state_code: existing.state_code, health_pct: existing.health_pct },
      after_state: { rated_voltage_v: input.rated_voltage_v, measured_voltage_v: input.measured_voltage_v, health_pct: health, suggestion, condition: input.condition ?? null },
      created_at: now,
    });
  });
  return view((await getBattery(input.tenant_id, input.battery_id))!);
}

export interface ChooseTriageInput {
  tenant_id: string;
  actor_user_id: string;
  battery_id: string;
  choice: TriageChoice;
  note?: string | null;
}

export interface ChooseTriageResult extends TriageView {
  /** Present when the choice moved the pipeline row (auction / redeploy / scrap / refurbish). */
  transition: TransitionResult | null;
}

/**
 * R3: the NBFC clicks a branch.
 *   refurbish → pipeline `refurbishable` (needs health ≥ 70; the lot is sent from the refurbishment console)
 *   scrap     → pipeline `scrap` + battery `scrapped` (so the scrap desk lists it)
 *   auction   → pipeline `ready_for_auction` (the existing bypass arc; publishes a lot)
 *   redeploy  → pipeline `redeploy` (stub: recorded + admin notified by the route)
 */
export async function chooseTriage(input: ChooseTriageInput): Promise<ChooseTriageResult> {
  const battery = await getBattery(input.tenant_id, input.battery_id);
  if (!battery) throw new Error("NOT_FOUND: battery not found");
  if (battery.health_pct == null) throw new Error("CONFLICT: record the recovery details (rated / measured voltage) before choosing");
  if (!allowedChoices(battery.health_pct).includes(input.choice)) {
    throw new Error(`CONFLICT: health is ${battery.health_pct}% — not suitable for refurbishing (floor ${TRIAGE_REFURB_MIN_PCT}%)`);
  }
  if (!battery.recovery_pipeline_id) {
    throw new Error("CONFLICT: this battery has no recovery pipeline row — flag its loan for recovery first");
  }
  const now = new Date();
  let transition: TransitionResult | null = null;
  const target = input.choice === "refurbish" ? "refurbishable" : input.choice === "scrap" ? "scrap" : input.choice === "auction" ? "ready_for_auction" : "redeploy";

  const [pipe] = await db
    .select({ stage: nbfcRecoveryPipeline.stage })
    .from(nbfcRecoveryPipeline)
    .where(eq(nbfcRecoveryPipeline.id, battery.recovery_pipeline_id))
    .limit(1);
  // Choosing the branch the row is already on is a no-op, not an error.
  if (pipe && pipe.stage !== target) {
    transition = await transitionStage({
      tenant_id: input.tenant_id,
      actor_user_id: input.actor_user_id,
      recovery_pipeline_id: battery.recovery_pipeline_id,
      target_stage: target,
      note: input.note ?? `triage: ${input.choice}`,
      soh_fallback: battery.health_pct,
    });
  }
  await db
    .update(recoveryBatteries)
    .set({
      triage_choice: input.choice,
      triaged_at: now,
      triaged_by: input.actor_user_id,
      // transitionStage() never writes state_code; the scrap desk reads it.
      ...(input.choice === "scrap" ? { state_code: "scrapped" } : {}),
      updated_at: now,
    })
    .where(and(eq(recoveryBatteries.id, input.battery_id), eq(recoveryBatteries.tenant_id, input.tenant_id)));

  return { ...view((await getBattery(input.tenant_id, input.battery_id))!), transition };
}
