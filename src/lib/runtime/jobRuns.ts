// ID 227 — record when each in-process scheduled job last ran.
//
// Every ticker in src/instrumentation-node.ts is started inside runAsJob(name)
// (src/lib/runtime/liveSite.ts). trackTick(fn) wraps one tick of it: it reads
// that job name, runs the tick, and upserts scheduled_job_state (E-372) so Ops
// Console > Jobs can show "last run" per job.
//
// Cheap on purpose: some tickers fire every 10-30 s, so a job's row is written
// at most once a minute — except a failure, which is always written. The write
// goes through the small background pool, is never awaited by the tick, and is
// skipped while E-372 is not applied (to_regclass probe, re-checked every 10 min).
//
// Failures: the tick bodies catch their own errors and log
// "[instrumentation:<job>] … failed: <message>" with console.error — 31 of them,
// each with its own shape. Instead of editing every catch block, a tracked tick
// runs inside its own AsyncLocalStorage store, and console.error is wrapped once
// so a "failed" line logged while that tick runs marks the tick failed with that
// message. Lines outside a tracked tick are untouched.

import { AsyncLocalStorage } from "node:async_hooks";
import { currentJob } from "./liveSite";

type TickState = { failed: string | null };

const ticks = new AsyncLocalStorage<TickState>();

const WRITE_EVERY_MS = 60_000;
const PROBE_EVERY_MS = 10 * 60_000;
const ERROR_MAX = 500;

const lastWrite = new Map<string, number>();
const runsSinceWrite = new Map<string, number>();
let tablePresent: boolean | null = null;
let probedAt = 0;
let consolePatched = false;

/**
 * A ticker's own failure line → its message; anything else → null.
 * Every ticker logs "[instrumentation:<job>] … failed:" from its catch block.
 * Lines from the work itself ("[backfill-cost] bolna X failed:" for one call)
 * do not count: one item failing is not the job failing.
 */
export function failureFromLog(args: unknown[]): string | null {
  const first = args[0];
  if (typeof first !== "string" || !/^\[instrumentation:[^\]]+\][^:]*\bfailed:/i.test(first)) return null;
  const text = args
    .map((a) => (a instanceof Error ? a.message : typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ")
    .trim();
  return text.length > ERROR_MAX ? `${text.slice(0, ERROR_MAX - 1)}…` : text;
}

function patchConsole(): void {
  if (consolePatched) return;
  consolePatched = true;
  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    const state = ticks.getStore();
    if (state && !state.failed) {
      const msg = failureFromLog(args);
      if (msg) state.failed = msg;
    }
    original(...args);
  };
}

async function hasTable(): Promise<boolean> {
  const now = Date.now();
  if (tablePresent !== null && now - probedAt < PROBE_EVERY_MS) return tablePresent;
  probedAt = now;
  try {
    const { bgDb } = await import("@/lib/db/background");
    const { sql } = await import("drizzle-orm");
    const res = (await bgDb.execute(sql`
      SELECT to_regclass('public.scheduled_job_state') IS NOT NULL AS ok
    `)) as unknown as Array<{ ok: boolean }>;
    tablePresent = Boolean(res[0]?.ok);
  } catch {
    tablePresent = false;
  }
  return tablePresent;
}

/** Should this tick's result be written now? Pure; exported for tests. */
export function shouldWrite(
  lastWriteAt: number | undefined,
  now: number,
  failed: boolean,
  everyMs = WRITE_EVERY_MS,
): boolean {
  return failed || lastWriteAt === undefined || now - lastWriteAt >= everyMs;
}

async function record(name: string, startedAt: Date, failed: string | null): Promise<void> {
  const now = Date.now();
  const runs = (runsSinceWrite.get(name) ?? 0) + 1;
  if (!shouldWrite(lastWrite.get(name), now, Boolean(failed))) {
    runsSinceWrite.set(name, runs);
    return;
  }
  if (!(await hasTable())) return;
  lastWrite.set(name, now);
  runsSinceWrite.set(name, 0);
  const finishedAt = new Date(now).toISOString();
  const started = startedAt.toISOString();
  const status = failed ? "failed" : "ok";
  try {
    const { bgDb } = await import("@/lib/db/background");
    const { sql } = await import("drizzle-orm");
    await bgDb.execute(sql`
      INSERT INTO scheduled_job_state
             (name, last_started_at, last_finished_at, last_status, last_error,
              last_failed_at, run_count, updated_at)
      VALUES (${name}, ${started}::timestamptz, ${finishedAt}::timestamptz, ${status},
              ${failed}, ${failed ? finishedAt : null}::timestamptz, ${runs}, now())
      ON CONFLICT (name) DO UPDATE SET
             last_started_at  = EXCLUDED.last_started_at,
             last_finished_at = EXCLUDED.last_finished_at,
             last_status      = EXCLUDED.last_status,
             last_error       = COALESCE(EXCLUDED.last_error, scheduled_job_state.last_error),
             last_failed_at   = COALESCE(EXCLUDED.last_failed_at, scheduled_job_state.last_failed_at),
             run_count        = scheduled_job_state.run_count + EXCLUDED.run_count,
             updated_at       = now()
    `);
  } catch (err) {
    // Never let bookkeeping break a job; one line, no rethrow. Logged outside
    // any tick store, so it cannot mark anything failed.
    ticks.exit(() =>
      console.warn("[job-runs] could not record", name, err instanceof Error ? err.message : err),
    );
  }
}

/** The job-state row name: the runAsJob name, plus a part for multi-tick jobs. */
export function jobRunName(job: string | undefined, part?: string): string {
  const base = job ?? "unnamed";
  return part ? `${base}:${part}` : base;
}

/**
 * Wrap one ticker's tick so each run is recorded under the job it was started
 * as. Call it inside the ticker's start function (inside runAsJob); `part`
 * names one of several ticks of the same job (dialer poll / watchdog / window).
 */
export function trackTick(fn: () => unknown, part?: string): () => Promise<void> {
  patchConsole();
  const name = jobRunName(currentJob(), part);
  return async () => {
    const state: TickState = { failed: null };
    const startedAt = new Date();
    await ticks.run(state, async () => {
      try {
        await fn();
      } catch (err) {
        // A tick that throws instead of catching: log it the house way, which
        // also marks this tick failed through the console.error wrapper.
        console.error(`[instrumentation:${name}] tick failed:`, err instanceof Error ? err.message : err);
        if (!state.failed) state.failed = `tick failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    });
    void record(name, startedAt, state.failed);
  };
}
