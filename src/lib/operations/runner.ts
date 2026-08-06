/**
 * The collector runner: scheduling, the single-flight lock, timeouts,
 * persistence and alert evaluation.
 *
 * One ticker calls runDueCollectors() every 60 seconds. Each collector declares
 * its own intervalMs and the runner executes only the ones whose last completed
 * run is older than that — one timer, per-collector cadence, and
 * /operations/jobs observability for free.
 *
 * Design rule, learned from every other job in this repo: a failing collector
 * fails ITSELF. It records a failed run row and the others carry on. A
 * monitoring system that goes dark because one vendor's API timed out is worse
 * than no monitoring, because it looks green.
 */

import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { opsCollectorRuns, opsMetricSamples } from "@/lib/db/schema";
import { log } from "@/lib/log";

import { COLLECTORS } from "./collectors";
import { DEFAULT_TIMEOUT_MS, isDue, withTimeout } from "./scheduling";
import type { CollectedSample, OpsCollector } from "./collectors/types";

/** A run still 'running' after this long is presumed dead and reaped. */
export const RUN_TIMEOUT_MINUTES = 15;

// Scheduling primitives live in ./scheduling so they can be unit-tested
// without pulling `db` into the test graph. Re-exported here because callers
// (and the ticker) have always imported them from the runner.
export { DEFAULT_TIMEOUT_MS, isDue, withTimeout } from "./scheduling";

export type RunTrigger = "ticker" | "manual";

export class CollectorInFlightError extends Error {
  constructor(
    public readonly collectorId: string,
    public readonly startedAt: Date,
  ) {
    super(`Collector ${collectorId} is already running.`);
    this.name = "CollectorInFlightError";
  }
}

/**
 * Drizzle wraps the driver error: the pg error carrying code '23505' is on
 * `.cause`, not the top-level object (the thrown error's message is just
 * "Failed query: insert into ..."). Walk the cause chain so a wrapped
 * unique-violation is still recognised — otherwise the lock collision
 * propagates as a 500 instead of the intended "already running".
 *
 * Copied deliberately from src/lib/nbfc/risk-run.ts rather than imported: that
 * module is NBFC-tenant-shaped and importing it here would drag its schema and
 * tenant types into the ops graph for four lines of logic.
 */
function isUniqueViolation(e: unknown): boolean {
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

/**
 * Mark long-running rows as failed so a process that crashed mid-run cannot
 * hold a collector's lock forever. RUN_TIMEOUT_MINUTES is far beyond any
 * collector's own timeout, so this only ever catches genuinely dead runs.
 */
async function reapStaleRuns(collectorId?: string): Promise<void> {
  const cutoff = new Date(Date.now() - RUN_TIMEOUT_MINUTES * 60_000);
  const conditions = [
    eq(opsCollectorRuns.status, "running"),
    lt(opsCollectorRuns.started_at, cutoff),
  ];
  if (collectorId) {
    conditions.push(eq(opsCollectorRuns.collector_id, collectorId));
  }

  await db
    .update(opsCollectorRuns)
    .set({
      status: "failed",
      finished_at: new Date(),
      error: `Run exceeded ${RUN_TIMEOUT_MINUTES} minutes and was presumed dead.`,
    })
    .where(and(...conditions));
}

/**
 * Claim the right to run this collector, or throw CollectorInFlightError.
 *
 * The lock is the partial unique index `(collector_id) WHERE status='running'`
 * from E-210, so two concurrent ticks cannot both win — one gets a 23505.
 */
export async function beginRun(
  collectorId: string,
  trigger: RunTrigger,
  actorUserId?: string | null,
): Promise<string> {
  await reapStaleRuns(collectorId);

  try {
    const [row] = await db
      .insert(opsCollectorRuns)
      .values({
        collector_id: collectorId,
        triggered_by: trigger,
        actor_user_id: actorUserId ?? null,
        status: "running",
      })
      .returning({ id: opsCollectorRuns.id });
    return row!.id;
  } catch (e) {
    if (isUniqueViolation(e)) {
      const [active] = await db
        .select({ started_at: opsCollectorRuns.started_at })
        .from(opsCollectorRuns)
        .where(
          and(
            eq(opsCollectorRuns.collector_id, collectorId),
            eq(opsCollectorRuns.status, "running"),
          ),
        )
        .limit(1);
      throw new CollectorInFlightError(
        collectorId,
        active?.started_at ?? new Date(),
      );
    }
    throw e;
  }
}

export async function completeRun(
  runId: string,
  startedAt: number,
  samplesWritten: number,
): Promise<void> {
  await db
    .update(opsCollectorRuns)
    .set({
      status: "completed",
      finished_at: new Date(),
      duration_ms: Date.now() - startedAt,
      samples_written: samplesWritten,
    })
    .where(eq(opsCollectorRuns.id, runId));
}

export async function failRun(
  runId: string,
  startedAt: number,
  error: unknown,
): Promise<void> {
  const msg = error instanceof Error ? error.message : String(error);
  await db
    .update(opsCollectorRuns)
    .set({
      status: "failed",
      finished_at: new Date(),
      duration_ms: Date.now() - startedAt,
      error: msg.slice(0, 2000),
    })
    .where(eq(opsCollectorRuns.id, runId));
}

export async function writeSamples(samples: CollectedSample[]): Promise<number> {
  if (samples.length === 0) return 0;

  const rows = samples.map((s) => ({
    metric_key: s.metric_key,
    source: s.source,
    captured_at: s.captured_at ?? new Date(),
    // numeric columns take a string through Drizzle; String() here rather than
    // at every call site so collectors can hand back plain numbers.
    value_num:
      s.value_num == null || !Number.isFinite(s.value_num)
        ? null
        : String(s.value_num),
    value_text: s.value_text ?? null,
    meta: s.meta ?? null,
  }));

  // Chunked because a collector that enumerates every table in the database
  // can produce a few hundred samples, and one oversized INSERT is a worse
  // failure than four ordinary ones.
  const CHUNK = 250;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db.insert(opsMetricSamples).values(rows.slice(i, i + CHUNK));
  }
  return rows.length;
}

/** Last time each collector STARTED, whatever the outcome. */
async function lastStartedAt(
  collectorIds: string[],
): Promise<Map<string, Date>> {
  if (collectorIds.length === 0) return new Map();

  const rows = await db
    .select({
      collector_id: opsCollectorRuns.collector_id,
      last_started: sql<string>`MAX(${opsCollectorRuns.started_at})`,
    })
    .from(opsCollectorRuns)
    .where(inArray(opsCollectorRuns.collector_id, collectorIds))
    .groupBy(opsCollectorRuns.collector_id);

  const out = new Map<string, Date>();
  for (const r of rows) {
    if (r.last_started) out.set(r.collector_id, new Date(r.last_started));
  }
  return out;
}

export interface RunOutcome {
  collector_id: string;
  status: "completed" | "failed" | "skipped";
  samples: number;
  duration_ms: number;
  error?: string;
}

/** Run one collector end to end. Never throws — the outcome is the return value. */
export async function runCollector(
  collector: OpsCollector,
  trigger: RunTrigger,
  actorUserId?: string | null,
): Promise<RunOutcome> {
  const startedAt = Date.now();

  let runId: string;
  try {
    runId = await beginRun(collector.id, trigger, actorUserId);
  } catch (e) {
    if (e instanceof CollectorInFlightError) {
      // Not an error: the previous run is still going. Say so and move on.
      return {
        collector_id: collector.id,
        status: "skipped",
        samples: 0,
        duration_ms: 0,
        error: "already running",
      };
    }
    log.error(`[ops] could not start collector ${collector.id}`, e);
    return {
      collector_id: collector.id,
      status: "failed",
      samples: 0,
      duration_ms: Date.now() - startedAt,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  try {
    const samples = await withTimeout(
      collector.run(),
      collector.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      collector.id,
    );
    const written = await writeSamples(samples);
    await completeRun(runId, startedAt, written);
    return {
      collector_id: collector.id,
      status: "completed",
      samples: written,
      duration_ms: Date.now() - startedAt,
    };
  } catch (e) {
    // log.error is rate-limited (30s dedupe on the message). A collector that
    // fails every 60s must not be able to fill the disk — the reason
    // src/lib/log.ts exists at all.
    log.error(`[ops] collector ${collector.id} failed`, e);
    await failRun(runId, startedAt, e).catch(() => {
      /* the DB is the thing that's broken; nothing useful left to do */
    });
    return {
      collector_id: collector.id,
      status: "failed",
      samples: 0,
      duration_ms: Date.now() - startedAt,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * The ticker's entry point. Runs every collector that is due, concurrently,
 * and returns what happened.
 *
 * Concurrency is bounded: collectors mostly talk to the same RDS instance that
 * `db` caps at max: 5 connections, and firing a dozen at once would have the
 * monitoring competing with the application it is monitoring.
 */
export async function runDueCollectors(
  trigger: RunTrigger = "ticker",
): Promise<RunOutcome[]> {
  // Reap first, globally: a collector removed from COLLECTORS between deploys
  // would otherwise leave a 'running' row nobody ever clears.
  await reapStaleRuns();

  const lastStarts = await lastStartedAt(COLLECTORS.map((c) => c.id));
  const now = Date.now();
  const due = COLLECTORS.filter((c) =>
    isDue(c.intervalMs, lastStarts.get(c.id), now),
  );

  if (due.length === 0) return [];

  const CONCURRENCY = 3;
  const outcomes: RunOutcome[] = [];
  for (let i = 0; i < due.length; i += CONCURRENCY) {
    const batch = due.slice(i, i + CONCURRENCY);
    outcomes.push(
      ...(await Promise.all(batch.map((c) => runCollector(c, trigger)))),
    );
  }

  const failed = outcomes.filter((o) => o.status === "failed");
  if (failed.length > 0) {
    log.warn(
      `[ops] ${failed.length}/${outcomes.length} collectors failed`,
      failed.map((f) => `${f.collector_id}: ${f.error}`),
    );
  }

  return outcomes;
}

export interface CollectorHealth {
  collector_id: string;
  label: string;
  interval_ms: number;
  last_run_at: Date | null;
  finished_at: Date | null;
  status: string | null;
  duration_ms: number | null;
  samples_written: number | null;
  error: string | null;
  /** Missed at least two of its own intervals — treat its numbers as stale. */
  is_stale: boolean;
  in_flight: boolean;
}

/**
 * One row per REGISTERED collector, joined to its latest run — including
 * collectors that have never run, which is precisely the state
 * /operations/jobs exists to make visible.
 */
export async function getCollectorHealth(): Promise<CollectorHealth[]> {
  const ids = COLLECTORS.map((c) => c.id);
  if (ids.length === 0) return [];

  // DISTINCT ON is the cheap "latest row per group" in Postgres and matches the
  // (collector_id, started_at DESC) index exactly.
  const rows = await db.execute<{
    collector_id: string;
    started_at: string;
    finished_at: string | null;
    status: string;
    duration_ms: number | null;
    samples_written: number | null;
    error: string | null;
  }>(sql`
    SELECT DISTINCT ON (collector_id)
      collector_id, started_at, finished_at, status, duration_ms,
      samples_written, error
    FROM ops_collector_runs
    WHERE collector_id IN ${ids}
    ORDER BY collector_id, started_at DESC
  `);

  const latest = new Map(
    (rows as unknown as Array<Record<string, unknown>>).map((r) => [
      r.collector_id as string,
      r,
    ]),
  );

  return COLLECTORS.map((c) => {
    const r = latest.get(c.id);
    const startedAt = r?.started_at ? new Date(r.started_at as string) : null;
    const finishedAt = r?.finished_at ? new Date(r.finished_at as string) : null;
    const status = (r?.status as string) ?? null;

    // Two missed intervals, not one: a collector that starts a few seconds
    // late every cycle is healthy, and flagging it would train people to
    // ignore the flag.
    const reference = finishedAt ?? startedAt;
    const isStale =
      !reference || Date.now() - reference.getTime() > c.intervalMs * 2;

    return {
      collector_id: c.id,
      label: c.label,
      interval_ms: c.intervalMs,
      last_run_at: startedAt,
      finished_at: finishedAt,
      status,
      duration_ms: (r?.duration_ms as number) ?? null,
      samples_written: (r?.samples_written as number) ?? null,
      error: (r?.error as string) ?? null,
      is_stale: isStale,
      in_flight: status === "running",
    };
  }).sort((a, b) => a.collector_id.localeCompare(b.collector_id));
}

/**
 * How long ago ANY collector last completed. The one-slide board's freshness
 * footer — if this number is climbing, every other number on the page is a
 * historical curiosity.
 */
export async function getMonitorFreshness(): Promise<{
  last_completed_at: Date | null;
  minutes_ago: number | null;
}> {
  const [row] = await db
    .select({ finished_at: opsCollectorRuns.finished_at })
    .from(opsCollectorRuns)
    .where(eq(opsCollectorRuns.status, "completed"))
    .orderBy(desc(opsCollectorRuns.finished_at))
    .limit(1);

  const at = row?.finished_at ?? null;
  return {
    last_completed_at: at,
    minutes_ago: at ? (Date.now() - at.getTime()) / 60_000 : null,
  };
}

export function findCollector(id: string): OpsCollector | undefined {
  return COLLECTORS.find((c) => c.id === id);
}
