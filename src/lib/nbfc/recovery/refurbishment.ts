/**
 * E-233 — refurbishment jobs (Battery Auction BRD §5, §15).
 *
 * The NBFC raises a job against a recovered battery, the iTarang workshop works
 * it, and the battery comes back and re-enters at `ready_for_auction`.
 *
 * REFURBISHMENT IS RECOMMENDED, NEVER MANDATORY. The stage machine allows
 * needs_inspection -> ready_for_auction directly, so this whole module is an
 * optional detour, not a gate. Nothing here may become a precondition of
 * selling a battery.
 */
import { db } from "@/lib/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  refurbishmentJobs,
  recoveryBatteries,
  nbfcRecoveryPipeline,
  nbfcBatteryEvaluations,
  nbfcAuditLog,
} from "@/lib/db/schema";
import { assertSohAllowsStage } from "@/lib/nbfc/recovery/stages";

/**
 * [E-270] `declined` and `ready` joined the vocabulary when jobs became lot
 * items: admin can refuse one battery out of a batch, and a repaired battery
 * waits at the workshop (`ready`) for the return truck before the NBFC's
 * receipt marks it `returned`.
 */
export const REFURB_STATUSES = [
  "requested",
  "declined",
  "in_progress",
  "ready",
  "returned",
  "cancelled",
] as const;
export type RefurbStatus = (typeof REFURB_STATUSES)[number];

/** Open = occupying the one-job-per-battery slot enforced by E-233/E-270's index. */
export const OPEN_STATUSES: RefurbStatus[] = ["requested", "in_progress", "ready"];

export const ALLOWED_TRANSITIONS: Record<RefurbStatus, RefurbStatus[]> = {
  requested: ["in_progress", "declined", "cancelled"],
  // `returned` straight from in_progress is the legacy single-job path (E-233);
  // a lot item goes in_progress -> ready -> returned.
  in_progress: ["ready", "returned", "cancelled"],
  ready: ["returned", "cancelled"],
  returned: [], // terminal
  declined: [], // terminal
  cancelled: [], // terminal
};

/**
 * BRD §15 — these three must be NEW on every refurbished battery. The list is
 * the default the UI pre-fills; the operator may adjust unit costs but the
 * three keys are not optional, which is why they are a constant here rather
 * than free-form rows the form invents.
 *
 * ~₹7–8k all-in, costed separately and then rolled into the lot base price so
 * the dealer sees ONE number rather than an itemised bill.
 */
export const REQUIRED_ACCESSORIES = [
  { key: "charger", label: "Charger", unit_cost: 3500 },
  { key: "harness", label: "Wiring harness", unit_cost: 2200 },
  { key: "soc_meter", label: "SOC meter", unit_cost: 1800 },
] as const;

export interface AccessoryLine {
  key: string;
  label: string;
  unit_cost: number;
  included: boolean;
}

export interface ChecklistItem {
  key: string;
  label: string;
  done: boolean;
  note?: string | null;
}

export interface RefurbishmentJobRow {
  id: string;
  tenant_id: string;
  battery_id: string;
  battery_serial: string | null;
  recovery_pipeline_id: string | null;
  assigned_workshop: string | null;
  checklist: ChecklistItem[];
  accessories: AccessoryLine[];
  estimated_cost: number | null;
  actual_cost: number | null;
  /** estimated/actual cost PLUS the included accessories. */
  total_cost: number | null;
  status: string;
  notes: string | null;
  requested_at: string;
  started_at: string | null;
  returned_at: string | null;
  /** [E-270] lot membership + per-battery decision / receipt facts. */
  lot_id: string | null;
  decline_reason: string | null;
  decided_at: string | null;
  out_received_condition: string | null;
  out_received_note: string | null;
  out_received_photo_urls: string[];
  ready_at: string | null;
  ret_received_condition: string | null;
  ret_received_note: string | null;
  ret_received_photo_urls: string[];
  ret_received_at: string | null;
}

export function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function iso(v: unknown): string | null {
  if (!v) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

/**
 * [E-270] The measured state of health of a battery — `step1.soh_percent` of
 * its latest evaluation. The same lookup transitionStage() does; exported so
 * the lot path and the legacy single-job path enforce the SAME 70% floor.
 */
export async function latestSohForBattery(
  tenant_id: string,
  recovery_pipeline_id: string | null,
): Promise<number | null> {
  if (!recovery_pipeline_id) return null;
  const [latestEval] = await db
    .select({ step1: nbfcBatteryEvaluations.step1 })
    .from(nbfcBatteryEvaluations)
    .where(
      and(
        eq(nbfcBatteryEvaluations.recovery_pipeline_id, recovery_pipeline_id),
        eq(nbfcBatteryEvaluations.tenant_id, tenant_id),
      ),
    )
    .orderBy(desc(nbfcBatteryEvaluations.created_at))
    .limit(1);
  const soh =
    latestEval && typeof latestEval.step1 === "object" && latestEval.step1 !== null
      ? Number((latestEval.step1 as Record<string, unknown>).soh_percent)
      : NaN;
  return Number.isFinite(soh) ? soh : null;
}

export function accessoriesTotal(accessories: AccessoryLine[]): number {
  return accessories
    .filter((a) => a.included)
    .reduce((sum, a) => sum + (Number(a.unit_cost) || 0), 0);
}

export function shapeJob(
  row: typeof refurbishmentJobs.$inferSelect,
  battery_serial: string | null,
): RefurbishmentJobRow {
  const accessories = (row.accessories as AccessoryLine[]) ?? [];
  const labour = num(row.actual_cost) ?? num(row.estimated_cost);
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    battery_id: row.battery_id,
    battery_serial,
    recovery_pipeline_id: row.recovery_pipeline_id ?? null,
    assigned_workshop: row.assigned_workshop ?? null,
    checklist: (row.checklist as ChecklistItem[]) ?? [],
    accessories,
    estimated_cost: num(row.estimated_cost),
    actual_cost: num(row.actual_cost),
    total_cost: labour === null ? null : labour + accessoriesTotal(accessories),
    status: row.status,
    notes: row.notes ?? null,
    requested_at: iso(row.requested_at) ?? "",
    started_at: iso(row.started_at),
    returned_at: iso(row.returned_at),
    lot_id: row.lot_id ?? null,
    decline_reason: row.decline_reason ?? null,
    decided_at: iso(row.decided_at),
    out_received_condition: row.out_received_condition ?? null,
    out_received_note: row.out_received_note ?? null,
    out_received_photo_urls: row.out_received_photo_urls ?? [],
    ready_at: iso(row.ready_at),
    ret_received_condition: row.ret_received_condition ?? null,
    ret_received_note: row.ret_received_note ?? null,
    ret_received_photo_urls: row.ret_received_photo_urls ?? [],
    ret_received_at: iso(row.ret_received_at),
  };
}

export interface CreateJobInput {
  tenant_id: string;
  actor_user_id: string;
  battery_id: string;
  assigned_workshop?: string | null;
  estimated_cost?: number | null;
  checklist?: ChecklistItem[];
  accessories?: AccessoryLine[];
  notes?: string | null;
}

/**
 * Raises a job. Moves the battery to `refurbishing` in the same transaction —
 * a job whose battery still reads `ready` would be offered to a lot-composition
 * picker while it sits on a workbench.
 */
export async function createRefurbishmentJob(
  input: CreateJobInput,
): Promise<RefurbishmentJobRow> {
  const [battery] = await db
    .select()
    .from(recoveryBatteries)
    .where(
      and(
        eq(recoveryBatteries.id, input.battery_id),
        eq(recoveryBatteries.tenant_id, input.tenant_id),
      ),
    )
    .limit(1);
  if (!battery) throw new Error("NOT_FOUND: battery not found");
  if (battery.state_code === "scrapped") {
    throw new Error("CONFLICT: a scrapped battery cannot be refurbished");
  }
  if (battery.state_code === "lotted" || battery.state_code === "sold") {
    throw new Error(
      `CONFLICT: battery is ${battery.state_code} and cannot go to the workshop`,
    );
  }
  // [E-270] The 70% refurbishment floor used to be enforced only on the
  // Kanban stage transition and in UI hint text; a direct call could send a
  // 30% battery to the workshop. Same guard, same message, on the server.
  assertSohAllowsStage(
    await latestSohForBattery(input.tenant_id, battery.recovery_pipeline_id ?? null),
    "refurbishable",
  );

  // Check the open-job slot explicitly rather than letting the partial unique
  // index raise 23505. The index is the guarantee; this is the message.
  const [open] = await db
    .select({ id: refurbishmentJobs.id })
    .from(refurbishmentJobs)
    .where(
      and(
        eq(refurbishmentJobs.battery_id, input.battery_id),
        inArray(refurbishmentJobs.status, OPEN_STATUSES),
      ),
    )
    .limit(1);
  if (open) {
    throw new Error(
      `CONFLICT: battery ${battery.serial} already has an open refurbishment job (${open.id})`,
    );
  }

  const accessories: AccessoryLine[] =
    input.accessories ??
    REQUIRED_ACCESSORIES.map((a) => ({ ...a, included: true }));

  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(refurbishmentJobs)
      .values({
        tenant_id: input.tenant_id,
        battery_id: input.battery_id,
        recovery_pipeline_id: battery.recovery_pipeline_id ?? null,
        requested_by_user_id: input.actor_user_id,
        assigned_workshop: input.assigned_workshop ?? null,
        checklist: input.checklist ?? [],
        accessories,
        estimated_cost:
          input.estimated_cost != null ? String(input.estimated_cost) : null,
        notes: input.notes ?? null,
        status: "requested",
      })
      .returning();

    await tx
      .update(recoveryBatteries)
      .set({ state_code: "refurbishing", updated_at: new Date() })
      .where(eq(recoveryBatteries.id, input.battery_id));

    if (battery.recovery_pipeline_id) {
      await tx
        .update(nbfcRecoveryPipeline)
        .set({ stage: "refurbishable", updated_at: new Date() })
        .where(eq(nbfcRecoveryPipeline.id, battery.recovery_pipeline_id));
    }

    await tx.insert(nbfcAuditLog).values({
      tenant_id: input.tenant_id,
      user_id: input.actor_user_id,
      // action_type is varchar(32) — "refurbishment_job_created" is 25.
      action_type: "refurb_job_created",
      action_id: created.id,
      before_state: {
        battery_id: input.battery_id,
        battery_state: battery.state_code,
      },
      after_state: {
        job_id: created.id,
        battery_state: "refurbishing",
        estimated_cost: input.estimated_cost ?? null,
        accessories_total: accessoriesTotal(accessories),
      },
    });

    return shapeJob(created, battery.serial);
  });
}

export interface UpdateJobInput {
  tenant_id: string;
  actor_user_id: string;
  job_id: string;
  status?: RefurbStatus;
  assigned_workshop?: string | null;
  checklist?: ChecklistItem[];
  accessories?: AccessoryLine[];
  actual_cost?: number | null;
  notes?: string | null;
}

/**
 * Advances or edits a job.
 *
 * On `returned` the battery goes to `ready` and the pipeline row to
 * `ready_for_auction` — that is the point of the whole detour, and doing it
 * here rather than leaving it to the operator is what stops a repaired battery
 * sitting invisible in `refurbishing` forever.
 *
 * On `cancelled` the battery goes back to `inspected`, NOT to `ready`. A
 * cancelled job means the work did not happen, so the battery returns to the
 * state it was in before someone asked for it — claiming otherwise would put an
 * unrepaired battery into a lot as `refurbished`.
 */
export async function updateRefurbishmentJob(
  input: UpdateJobInput,
): Promise<RefurbishmentJobRow> {
  const [job] = await db
    .select()
    .from(refurbishmentJobs)
    .where(
      and(
        eq(refurbishmentJobs.id, input.job_id),
        eq(refurbishmentJobs.tenant_id, input.tenant_id),
      ),
    )
    .limit(1);
  if (!job) throw new Error("NOT_FOUND: refurbishment job not found");

  const nextStatus = input.status;
  if (nextStatus && nextStatus !== job.status) {
    const allowed = ALLOWED_TRANSITIONS[job.status as RefurbStatus] ?? [];
    if (!allowed.includes(nextStatus)) {
      throw new Error(
        `BAD_REQUEST: invalid refurbishment transition ${job.status} -> ${nextStatus}`,
      );
    }
  }

  const [battery] = await db
    .select()
    .from(recoveryBatteries)
    .where(eq(recoveryBatteries.id, job.battery_id))
    .limit(1);

  const now = new Date();

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(refurbishmentJobs)
      .set({
        ...(nextStatus ? { status: nextStatus } : {}),
        ...(input.assigned_workshop !== undefined
          ? { assigned_workshop: input.assigned_workshop }
          : {}),
        ...(input.checklist !== undefined ? { checklist: input.checklist } : {}),
        ...(input.accessories !== undefined
          ? { accessories: input.accessories }
          : {}),
        ...(input.actual_cost !== undefined
          ? { actual_cost: input.actual_cost === null ? null : String(input.actual_cost) }
          : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(nextStatus === "in_progress" && !job.started_at
          ? { started_at: now }
          : {}),
        ...(nextStatus === "returned" ? { returned_at: now } : {}),
        ...(nextStatus === "ready" ? { ready_at: now } : {}),
        updated_at: now,
      })
      .where(eq(refurbishmentJobs.id, input.job_id))
      .returning();

    if (nextStatus === "returned" || nextStatus === "cancelled") {
      const batteryState = nextStatus === "returned" ? "ready" : "inspected";
      await tx
        .update(recoveryBatteries)
        .set({
          state_code: batteryState,
          // A returned battery IS refurbished — that is what the job did, and
          // it is the grade the lot item will carry.
          ...(nextStatus === "returned" ? { condition_grade: "refurbished" } : {}),
          updated_at: now,
        })
        .where(eq(recoveryBatteries.id, job.battery_id));

      if (job.recovery_pipeline_id) {
        await tx
          .update(nbfcRecoveryPipeline)
          .set({
            stage:
              nextStatus === "returned" ? "ready_for_auction" : "needs_inspection",
            updated_at: now,
          })
          .where(eq(nbfcRecoveryPipeline.id, job.recovery_pipeline_id));
      }
    }

    await tx.insert(nbfcAuditLog).values({
      tenant_id: input.tenant_id,
      user_id: input.actor_user_id,
      action_type: "refurb_job_updated",
      action_id: input.job_id,
      before_state: {
        status: job.status,
        actual_cost: num(job.actual_cost),
      },
      after_state: {
        status: updated.status,
        actual_cost: num(updated.actual_cost),
        accessories_total: accessoriesTotal(
          (updated.accessories as AccessoryLine[]) ?? [],
        ),
      },
      created_at: now,
    });

    return shapeJob(updated, battery?.serial ?? null);
  });
}

export async function listRefurbishmentJobs(input: {
  tenant_id: string;
  status?: RefurbStatus | "open" | "all";
  battery_id?: string;
}): Promise<RefurbishmentJobRow[]> {
  const statusCondition =
    !input.status || input.status === "all"
      ? undefined
      : input.status === "open"
        ? inArray(refurbishmentJobs.status, OPEN_STATUSES)
        : eq(refurbishmentJobs.status, input.status);

  const rows = await db
    .select({
      job: refurbishmentJobs,
      serial: recoveryBatteries.serial,
    })
    .from(refurbishmentJobs)
    .leftJoin(
      recoveryBatteries,
      eq(recoveryBatteries.id, refurbishmentJobs.battery_id),
    )
    .where(
      and(
        ...[
          eq(refurbishmentJobs.tenant_id, input.tenant_id),
          statusCondition,
          input.battery_id
            ? eq(refurbishmentJobs.battery_id, input.battery_id)
            : undefined,
        ].filter(Boolean),
      ),
    )
    .orderBy(desc(refurbishmentJobs.requested_at));

  return rows.map((r) => shapeJob(r.job, r.serial ?? null));
}

/**
 * The refurbishment spend to roll into a lot's base price (BRD §15).
 * Returned jobs only — an open job has not been paid for and its estimate is
 * not a cost.
 */
export async function refurbishmentCostForBatteries(
  battery_ids: string[],
): Promise<Map<string, number>> {
  if (battery_ids.length === 0) return new Map();
  const rows = await db
    .select({
      battery_id: refurbishmentJobs.battery_id,
      actual_cost: refurbishmentJobs.actual_cost,
      estimated_cost: refurbishmentJobs.estimated_cost,
      accessories: refurbishmentJobs.accessories,
    })
    .from(refurbishmentJobs)
    .where(
      and(
        inArray(refurbishmentJobs.battery_id, battery_ids),
        eq(refurbishmentJobs.status, "returned"),
      ),
    );

  const out = new Map<string, number>();
  for (const r of rows) {
    const labour = num(r.actual_cost) ?? num(r.estimated_cost) ?? 0;
    const total = labour + accessoriesTotal((r.accessories as AccessoryLine[]) ?? []);
    out.set(r.battery_id, (out.get(r.battery_id) ?? 0) + total);
  }
  return out;
}
