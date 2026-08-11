/**
 * E-036 — Recovery pipeline stage management service (BRD §6.1.7).
 *
 * Provides:
 *   - listRecoveryPipeline(): paginated, tenant-scoped, optional stage filter.
 *   - transitionStage():       validates allowed transitions, updates the
 *                              recovery pipeline row, writes an immutable
 *                              nbfc_audit_log entry capturing before/after.
 *
 * Allowed transitions (per YAML extract of BRD §6.1.7):
 *   needs_inspection  -> refurbishable | scrap
 *   refurbishable     -> ready_for_auction
 *   ready_for_auction -> resold
 *
 * Anything else is a 400 (BAD_REQUEST). Tenant scoping is enforced explicitly
 * in every where-clause; cross-tenant rows surface as NOT_FOUND, never leak.
 */
import { db } from "@/lib/db";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  nbfcAuditLog,
  nbfcRecoveryPipeline,
  nbfcBatteryEvaluations,
} from "@/lib/db/schema";
import { publishLotFromRecovery } from "@/lib/nbfc/auction/createLot";

// ---------------------------------------------------------------------------
// Stage enum + transition graph
// ---------------------------------------------------------------------------
export const RECOVERY_STAGES = [
  "needs_inspection",
  "refurbishable",
  "scrap",
  "ready_for_auction",
  "resold",
] as const;
export type RecoveryStage = (typeof RECOVERY_STAGES)[number];

export const ALLOWED_TRANSITIONS: Record<RecoveryStage, RecoveryStage[]> = {
  // [E-233] `ready_for_auction` is new here — the BYPASS ARC.
  //
  // Refurbishment is RECOMMENDED, NEVER MANDATORY (Battery Auction BRD §5).
  // Until now the only route out of needs_inspection was via `refurbishable`,
  // so a battery that came back in perfect condition had to be booked into a
  // workshop it did not need before it could be sold. That was not a policy
  // decision, it was a missing edge.
  needs_inspection: ["refurbishable", "scrap", "ready_for_auction"],
  // A battery can also turn out to be beyond repair once the workshop opens
  // it, which is the other edge that was missing.
  refurbishable: ["ready_for_auction", "scrap"],
  scrap: [], // terminal
  ready_for_auction: ["resold"],
  resold: [], // terminal
};

// ---------------------------------------------------------------------------
// Grade bands — ONE definition, enforced server-side
// ---------------------------------------------------------------------------
// Three sources disagreed about when a battery is refurbishable and when it is
// scrap, and only the weakest of the three was ever enforced:
//
//   evaluation.ts computeBasePrice   scrap when soh < 70 AND decision='scrap'
//   RecoveryKanban.tsx               REFURBISHABLE_MIN_SOH = 70, CLIENT-SIDE ONLY
//   Battery Auction BRD, Figure 1    scrap when SOH < 55
//
// The Kanban rule was a disabled button and a tooltip. `transitionStage()` —
// the actual write path, reachable from a plain API call — happily accepted a
// 30% SOH battery as refurbishable. These constants are that rule, moved to the
// server.
//
// The bands reconcile the BRD with the shipped code rather than picking a side:
// 55 is the scrap floor the BRD asks for, 70 stays the refurbishment threshold
// the pricing engine and the UI already used, and the 55–70 gap becomes the
// `partial_working` grade that BRD §6 introduces and that nothing had a home
// for.
export const SOH_SCRAP_BELOW = 55;
export const SOH_REFURBISHABLE_MIN = 70;

export type ConditionGrade = "new" | "refurbished" | "partial_working";

/** The grade a battery earns from its measured state of health. */
export function gradeForSoh(soh: number | null | undefined): ConditionGrade | "scrap" {
  if (soh === null || soh === undefined || !Number.isFinite(soh)) {
    // No reading is not a passing reading. An ungraded battery cannot be
    // advertised, so it stays out of the auction rather than defaulting into
    // the most saleable grade.
    return "partial_working";
  }
  if (soh < SOH_SCRAP_BELOW) return "scrap";
  if (soh < SOH_REFURBISHABLE_MIN) return "partial_working";
  return "refurbished";
}

/**
 * Server-side guard for the stage the operator is asking for.
 *
 * Throws `BAD_REQUEST:` — which every NBFC route's `statusFromError` maps to
 * 400 — with the SOH in the message, because "this battery is too degraded" is
 * useless without the number that made it so.
 */
export function assertSohAllowsStage(
  soh: number | null | undefined,
  target: RecoveryStage,
): void {
  if (target !== "refurbishable" && target !== "ready_for_auction") return;
  if (soh === null || soh === undefined || !Number.isFinite(soh)) {
    throw new Error(
      `BAD_REQUEST: cannot move to ${target} before an evaluation records a state of health`,
    );
  }
  if (soh < SOH_SCRAP_BELOW) {
    throw new Error(
      `BAD_REQUEST: state of health is ${soh}%, below the ${SOH_SCRAP_BELOW}% scrap floor — this battery can only move to scrap`,
    );
  }
  if (target === "refurbishable" && soh < SOH_REFURBISHABLE_MIN) {
    throw new Error(
      `BAD_REQUEST: state of health is ${soh}%, below the ${SOH_REFURBISHABLE_MIN}% refurbishment threshold — grade it partial_working and send it straight to auction`,
    );
  }
}

export function isAllowedTransition(
  from: string,
  to: RecoveryStage,
): boolean {
  if (!(RECOVERY_STAGES as readonly string[]).includes(from)) return false;
  const allowed = ALLOWED_TRANSITIONS[from as RecoveryStage] ?? [];
  return allowed.includes(to);
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------
export interface ListInput {
  tenant_id: string;
  stage?: RecoveryStage;
  page: number;
  page_size: number;
}

export interface ListItem {
  id: string;
  battery_serial: string;
  stage: string;
  estimated_recovery_value: number | null;
  updated_at: string;
}

export interface ListResult {
  items: ListItem[];
  page: number;
  total: number;
}

export async function listRecoveryPipeline(
  input: ListInput,
): Promise<ListResult> {
  const where = input.stage
    ? and(
        eq(nbfcRecoveryPipeline.tenant_id, input.tenant_id),
        eq(nbfcRecoveryPipeline.stage, input.stage),
      )
    : eq(nbfcRecoveryPipeline.tenant_id, input.tenant_id);

  const offset = (input.page - 1) * input.page_size;

  const rows = await db
    .select({
      id: nbfcRecoveryPipeline.id,
      battery_serial: nbfcRecoveryPipeline.battery_serial,
      stage: nbfcRecoveryPipeline.stage,
      estimated_recovery_value: nbfcRecoveryPipeline.estimated_recovery_value,
      updated_at: nbfcRecoveryPipeline.updated_at,
    })
    .from(nbfcRecoveryPipeline)
    .where(where)
    .orderBy(desc(nbfcRecoveryPipeline.updated_at))
    .limit(input.page_size)
    .offset(offset);

  const totalRows = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(nbfcRecoveryPipeline)
    .where(where);
  const total = totalRows[0]?.c ?? 0;

  return {
    items: rows.map((r) => ({
      id: r.id,
      battery_serial: r.battery_serial,
      stage: r.stage,
      estimated_recovery_value:
        r.estimated_recovery_value === null ||
        r.estimated_recovery_value === undefined
          ? null
          : Number(r.estimated_recovery_value),
      updated_at: (r.updated_at instanceof Date
        ? r.updated_at
        : new Date(r.updated_at as unknown as string)
      ).toISOString(),
    })),
    page: input.page,
    total,
  };
}

// ---------------------------------------------------------------------------
// Transition
// ---------------------------------------------------------------------------
export interface TransitionInput {
  tenant_id: string;
  actor_user_id: string;
  recovery_pipeline_id: string;
  target_stage: RecoveryStage;
  note?: string;
}

export interface TransitionResult {
  id: string;
  stage: string;
  updated_at: string;
  /** Populated when target_stage='ready_for_auction' triggered a lot publish. */
  published_lot?: {
    lot_id: string;
    lot_code: string;
    base_price: number;
    ends_at: string;
  };
}

export async function transitionStage(
  input: TransitionInput,
): Promise<TransitionResult> {
  // 1. Resolve the row + tenant ownership.
  const rows = await db
    .select({
      id: nbfcRecoveryPipeline.id,
      tenant_id: nbfcRecoveryPipeline.tenant_id,
      battery_serial: nbfcRecoveryPipeline.battery_serial,
      stage: nbfcRecoveryPipeline.stage,
      estimated_recovery_value: nbfcRecoveryPipeline.estimated_recovery_value,
    })
    .from(nbfcRecoveryPipeline)
    .where(
      and(
        eq(nbfcRecoveryPipeline.id, input.recovery_pipeline_id),
        eq(nbfcRecoveryPipeline.tenant_id, input.tenant_id),
      ),
    )
    .limit(1);

  if (rows.length === 0) {
    throw new Error(
      "NOT_FOUND: recovery pipeline row not found for this tenant",
    );
  }
  const row = rows[0];

  // 2. Validate transition.
  if (!isAllowedTransition(row.stage, input.target_stage)) {
    throw new Error(
      `BAD_REQUEST: invalid stage transition ${row.stage} -> ${input.target_stage}`,
    );
  }

  // 2b. [E-233] Validate the transition against the MEASURED state of health.
  //
  // This check previously existed only in RecoveryKanban.tsx as a disabled
  // button and a tooltip, so any direct API call could push a 30% SOH battery
  // into `refurbishable` and on into an auction. The rule now lives on the
  // write path, where it cannot be bypassed by not using the UI.
  //
  // The reading comes from the most recent evaluation. Reading the LATEST one
  // matters: a battery re-inspected after refurbishment has two evaluations,
  // and judging it on the pre-repair figure would block the very promotion the
  // repair was for.
  const [latestEval] = await db
    .select({ step1: nbfcBatteryEvaluations.step1 })
    .from(nbfcBatteryEvaluations)
    .where(
      and(
        eq(nbfcBatteryEvaluations.recovery_pipeline_id, row.id),
        eq(nbfcBatteryEvaluations.tenant_id, input.tenant_id),
      ),
    )
    .orderBy(desc(nbfcBatteryEvaluations.created_at))
    .limit(1);

  const soh =
    latestEval && typeof latestEval.step1 === "object" && latestEval.step1 !== null
      ? Number((latestEval.step1 as Record<string, unknown>).soh_percent)
      : null;

  assertSohAllowsStage(Number.isFinite(soh as number) ? (soh as number) : null, input.target_stage);

  const now = new Date();

  // 3-5. Stage update + audit + (when promoting to auction) lot publish run
  // inside a single transaction so the recovery pipeline never lands on
  // "ready_for_auction" without a matching auction_lots row.
  const { updated, publishedLot } = await db.transaction(async (tx) => {
    const [updatedRow] = await tx
      .update(nbfcRecoveryPipeline)
      .set({ stage: input.target_stage, updated_at: now })
      .where(
        and(
          eq(nbfcRecoveryPipeline.id, input.recovery_pipeline_id),
          eq(nbfcRecoveryPipeline.tenant_id, input.tenant_id),
        ),
      )
      .returning({
        id: nbfcRecoveryPipeline.id,
        stage: nbfcRecoveryPipeline.stage,
        updated_at: nbfcRecoveryPipeline.updated_at,
      });

    let published: TransitionResult["published_lot"];
    if (input.target_stage === "ready_for_auction") {
      published = await publishLotFromRecovery({
        tenant_id: input.tenant_id,
        recovery_pipeline_id: input.recovery_pipeline_id,
        executor: tx,
      });
    }

    await tx.insert(nbfcAuditLog).values({
      tenant_id: input.tenant_id,
      user_id: input.actor_user_id,
      action_type: "recovery_stage_transition",
      action_id: row.id, // links audit entry back to pipeline row
      before_state: {
        recovery_pipeline_id: row.id,
        battery_serial: row.battery_serial,
        stage: row.stage,
      },
      after_state: {
        recovery_pipeline_id: row.id,
        battery_serial: row.battery_serial,
        stage: input.target_stage,
        note: input.note ?? null,
        published_lot: published ?? null,
      },
      created_at: now,
    });

    return { updated: updatedRow, publishedLot: published };
  });

  return {
    id: updated.id,
    stage: updated.stage,
    updated_at: (updated.updated_at instanceof Date
      ? updated.updated_at
      : new Date(updated.updated_at as unknown as string)
    ).toISOString(),
    published_lot: publishedLot,
  };
}
