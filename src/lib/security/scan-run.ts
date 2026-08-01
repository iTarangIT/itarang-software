/**
 * Lifecycle of a security scan: acquire the lock, record the outcome, expose
 * freshness. Self-contained — this is NOT the NBFC risk engine's run lock, it
 * just follows the same proven shape (src/lib/nbfc/risk-run.ts).
 *
 * The lock is the partial unique index `(target_env) WHERE status='running'`, so
 * two concurrent scans against the same environment cannot both win — one gets a
 * unique violation (23505). Presumed-dead runs are reaped first so a crashed
 * process cannot wedge an environment forever.
 */
import { and, desc, eq, lt } from "drizzle-orm";
import { db } from "@/lib/db";
import { securityScanRuns } from "@/lib/db/schema";
import type { ScanMode, TargetEnv } from "./types";

/** A run still 'running' after this long is presumed dead and reaped. */
export const RUN_TIMEOUT_MINUTES = 30;

/** Findings older than this mean the scan hasn't been re-run recently. */
export const STALE_AFTER_HOURS = 168; // 7 days

export type ScanTrigger = "manual" | "cron" | "cli";

export interface ScanSummary {
  surfaces_walked: number;
  findings_total: number;
  findings_critical: number;
  findings_high: number;
  findings_medium: number;
  findings_low: number;
  findings_info: number;
  prompt_tokens: number;
  completion_tokens: number;
}

export class ScanInFlightError extends Error {
  constructor(
    public readonly env: TargetEnv,
    public readonly startedAt: Date,
  ) {
    super(`A security scan is already running for the "${env}" environment.`);
    this.name = "ScanInFlightError";
  }
}

export interface BeginScanInput {
  targetEnv: TargetEnv;
  targetBaseUrl: string;
  mode: ScanMode;
  trigger: ScanTrigger;
  actorUserId?: string | null;
}

/**
 * Claim the right to scan this environment, or throw ScanInFlightError.
 * Returns the new run id.
 */
export async function beginScan(input: BeginScanInput): Promise<string> {
  await reapStaleRuns(input.targetEnv);

  try {
    const [row] = await db
      .insert(securityScanRuns)
      .values({
        target_env: input.targetEnv,
        target_base_url: input.targetBaseUrl,
        mode: input.mode,
        triggered_by: input.trigger,
        actor_user_id: input.actorUserId ?? null,
        status: "running",
      })
      .returning({ id: securityScanRuns.id });
    return row!.id;
  } catch (e) {
    if (isUniqueViolation(e)) {
      const [active] = await db
        .select({ started_at: securityScanRuns.started_at })
        .from(securityScanRuns)
        .where(
          and(
            eq(securityScanRuns.target_env, input.targetEnv),
            eq(securityScanRuns.status, "running"),
          ),
        )
        .limit(1);
      throw new ScanInFlightError(input.targetEnv, active?.started_at ?? new Date());
    }
    throw e;
  }
}

export async function completeScan(runId: string, summary: ScanSummary): Promise<void> {
  await db
    .update(securityScanRuns)
    .set({ ...summary, status: "completed", finished_at: new Date() })
    .where(eq(securityScanRuns.id, runId));
}

export async function failScan(runId: string, error: unknown): Promise<void> {
  const msg = error instanceof Error ? error.message : String(error);
  await db
    .update(securityScanRuns)
    .set({ status: "failed", finished_at: new Date(), error: msg.slice(0, 2000) })
    .where(eq(securityScanRuns.id, runId));
}

/** Mark long-running rows failed so a crashed process cannot hold the lock forever. */
async function reapStaleRuns(env: TargetEnv): Promise<void> {
  const cutoff = new Date(Date.now() - RUN_TIMEOUT_MINUTES * 60_000);
  await db
    .update(securityScanRuns)
    .set({
      status: "failed",
      finished_at: new Date(),
      error: `Scan exceeded ${RUN_TIMEOUT_MINUTES} minutes and was presumed dead.`,
    })
    .where(
      and(
        eq(securityScanRuns.target_env, env),
        eq(securityScanRuns.status, "running"),
        lt(securityScanRuns.started_at, cutoff),
      ),
    );
}

export interface ScanFreshness {
  last_run_at: Date | null;
  status: string | null;
  is_stale: boolean;
  in_flight: boolean;
}

/** Latest scan (optionally scoped to an env), and whether its findings have gone stale. */
export async function getScanFreshness(env?: TargetEnv): Promise<ScanFreshness> {
  const rows = await db
    .select({
      started_at: securityScanRuns.started_at,
      finished_at: securityScanRuns.finished_at,
      status: securityScanRuns.status,
    })
    .from(securityScanRuns)
    .where(env ? eq(securityScanRuns.target_env, env) : undefined)
    .orderBy(desc(securityScanRuns.started_at))
    .limit(1);

  const row = rows[0];
  if (!row) {
    return { last_run_at: null, status: null, is_stale: true, in_flight: false };
  }

  const at = row.finished_at ?? row.started_at;
  const ageHours = (Date.now() - at.getTime()) / 3_600_000;
  return {
    last_run_at: at,
    status: row.status,
    is_stale: row.status !== "completed" || ageHours > STALE_AFTER_HOURS,
    in_flight: row.status === "running",
  };
}

function isUniqueViolation(e: unknown): boolean {
  // The pg error carrying code '23505' rides on `.cause` under drizzle's wrapper.
  for (let err: unknown = e, depth = 0; err != null && depth < 5; depth++) {
    if (
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: string }).code === "23505"
    ) {
      return true;
    }
    err = (err as { cause?: unknown }).cause;
  }
  return false;
}
