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
import { nbfcAuditLog, nbfcRecoveryPipeline } from "@/lib/db/schema";

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
  needs_inspection: ["refurbishable", "scrap"],
  refurbishable: ["ready_for_auction"],
  scrap: [], // terminal
  ready_for_auction: ["resold"],
  resold: [], // terminal
};

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

  const now = new Date();

  // 3. Update the row.
  const [updated] = await db
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

  // 4. Append immutable audit-log row capturing before/after.
  await db.insert(nbfcAuditLog).values({
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
    },
    created_at: now,
  });

  return {
    id: updated.id,
    stage: updated.stage,
    updated_at: (updated.updated_at instanceof Date
      ? updated.updated_at
      : new Date(updated.updated_at as unknown as string)
    ).toISOString(),
  };
}
