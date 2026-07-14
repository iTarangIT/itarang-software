/**
 * Lifecycle of a risk-engine run: acquire the lock, record the outcome, expose
 * freshness.
 *
 * The engine used to have no run record at all. Two consequences we're fixing:
 * double-clicking "Re-run analysis" fired two full workflows against the same
 * tenant (each writing its own cards, the loser's silently shadowed), and a card
 * carried no signal of when it was produced — the page presented a March number
 * and a five-minute-old number identically.
 */
import { and, desc, eq, lt } from "drizzle-orm";
import { db } from "@/lib/db";
import { nbfcTenants, riskRuns } from "@/lib/db/schema";
import type { TenantContext } from "@/lib/nbfc/tenant";

/** A run still 'running' after this long is presumed dead and reaped. */
export const RUN_TIMEOUT_MINUTES = 15;

/** Cards older than this are stale — the nightly cron should have replaced them. */
export const STALE_AFTER_HOURS = 36;

export type RunTrigger = "manual" | "cron";

export interface RunSummary {
  cards_generated: number;
  cards_computed: number;
  cards_inconclusive: number;
  cards_errored: number;
  prompt_tokens: number;
  completion_tokens: number;
}

export class RunInFlightError extends Error {
  constructor(public readonly startedAt: Date) {
    super("A risk analysis is already running for this tenant.");
    this.name = "RunInFlightError";
  }
}

/**
 * Claim the right to run for this tenant, or throw RunInFlightError.
 *
 * The lock is the partial unique index `(tenant_id) WHERE status='running'`, so
 * two concurrent callers cannot both win — one of them gets a unique violation.
 * We reap presumed-dead runs first, otherwise a process that crashed mid-run
 * would wedge the tenant forever.
 */
export async function beginRiskRun(
  tenantId: string,
  trigger: RunTrigger,
  actorUserId?: string | null,
): Promise<string> {
  await reapStaleRuns(tenantId);

  try {
    const [row] = await db
      .insert(riskRuns)
      .values({
        tenant_id: tenantId,
        triggered_by: trigger,
        actor_user_id: actorUserId ?? null,
        status: "running",
      })
      .returning({ id: riskRuns.id, started_at: riskRuns.started_at });
    return row!.id;
  } catch (e) {
    // 23505 = unique_violation: someone else holds the lock.
    if (isUniqueViolation(e)) {
      const [active] = await db
        .select({ started_at: riskRuns.started_at })
        .from(riskRuns)
        .where(and(eq(riskRuns.tenant_id, tenantId), eq(riskRuns.status, "running")))
        .limit(1);
      throw new RunInFlightError(active?.started_at ?? new Date());
    }
    throw e;
  }
}

export async function completeRiskRun(runId: string, summary: RunSummary): Promise<void> {
  await db
    .update(riskRuns)
    .set({ ...summary, status: "completed", finished_at: new Date() })
    .where(eq(riskRuns.id, runId));
}

export async function failRiskRun(runId: string, error: unknown): Promise<void> {
  const msg = error instanceof Error ? error.message : String(error);
  await db
    .update(riskRuns)
    .set({ status: "failed", finished_at: new Date(), error: msg.slice(0, 2000) })
    .where(eq(riskRuns.id, runId));
}

/**
 * Mark long-running rows as failed so a crashed process cannot hold the lock
 * forever. Deliberately conservative: RUN_TIMEOUT_MINUTES is well beyond the
 * route's own 120s cap, so this only ever catches genuinely dead runs.
 */
async function reapStaleRuns(tenantId: string): Promise<void> {
  const cutoff = new Date(Date.now() - RUN_TIMEOUT_MINUTES * 60_000);
  await db
    .update(riskRuns)
    .set({
      status: "failed",
      finished_at: new Date(),
      error: `Run exceeded ${RUN_TIMEOUT_MINUTES} minutes and was presumed dead.`,
    })
    .where(
      and(
        eq(riskRuns.tenant_id, tenantId),
        eq(riskRuns.status, "running"),
        lt(riskRuns.started_at, cutoff),
      ),
    );
}

export interface RunFreshness {
  last_run_at: Date | null;
  status: string | null;
  is_stale: boolean;
  /** True when a run is in progress right now — the page can say so. */
  in_flight: boolean;
}

/** Latest run for the tenant, and whether the cards it produced have gone stale. */
export async function getRunFreshness(tenantId: string): Promise<RunFreshness> {
  const [row] = await db
    .select({
      started_at: riskRuns.started_at,
      finished_at: riskRuns.finished_at,
      status: riskRuns.status,
    })
    .from(riskRuns)
    .where(eq(riskRuns.tenant_id, tenantId))
    .orderBy(desc(riskRuns.started_at))
    .limit(1);

  if (!row) {
    // Never run. Not "fresh" — the cards on screen came from the inline
    // fallback evaluators, not from a recorded run.
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
  return typeof e === "object" && e !== null && "code" in e && (e as { code?: string }).code === "23505";
}

/**
 * Every active tenant, shaped as the TenantContext the workflow expects. The
 * nightly cron has no session to resolve a tenant from, so it sweeps them all.
 */
export async function listActiveTenants(): Promise<TenantContext[]> {
  const rows = await db
    .select({
      id: nbfcTenants.id,
      slug: nbfcTenants.slug,
      display_name: nbfcTenants.display_name,
      contact_email: nbfcTenants.contact_email,
      aum_inr: nbfcTenants.aum_inr,
      active_loans: nbfcTenants.active_loans,
    })
    .from(nbfcTenants)
    .where(eq(nbfcTenants.is_active, true))
    .orderBy(nbfcTenants.created_at);

  return rows.map((r) => ({ ...r, via: "cron" as const }));
}
