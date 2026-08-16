import { db } from "@/lib/db";
import { scrapeRuns, scraperJobQueue } from "@/lib/db/schema";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { generateId } from "@/lib/api-utils";
import { sanitizeDbError } from "@/lib/error-utils";
import { startChunkedRun } from "./chunkedPipeline";
import { markRunFailed, reapStuckRuns } from "./storage/runStore";
import type { Pair } from "./commandParser";

// E-241 — the scraper batch job queue.
//
// One row of scraper_job_queue = one (query, city) pair waiting to become an
// ordinary scraper_runs row. Everything downstream of dispatch is untouched:
// the run this creates is indistinguishable from one a human started, so chunk
// execution, finalize, dedupe, promotion into dealer_leads, the progress poll
// and the run-detail page all work with no knowledge of the queue at all.
//
// THE CLOCK IS THE DATABASE'S. Every time comparison in this file happens in
// SQL against now(), never against a JS Date — the rule
// src/lib/nbfc/auction/scheduler.ts records after clock skew on the pm2 VPS made
// auction lots close minutes late. It also means two processes cannot disagree
// about whether a window is open.

export type JobStatus =
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "cancelled";

export type ScheduleMode = "now" | "once" | "daily";

export const WEEKDAYS = [
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface BatchSchedule {
  mode: ScheduleMode;
  run_after?: string | null;
  window_start?: string | null;
  window_end?: string | null;
  window_days?: Weekday[] | null;
}

export interface EnqueueBatchInput {
  pairs: Pair[];
  expandWithAi: boolean;
  schedule: BatchSchedule;
  userId: string;
}

// ── enqueue ────────────────────────────────────────────────────────────────

export async function enqueueBatch(
  input: EnqueueBatchInput,
): Promise<{ batchId: string; queued: number }> {
  const batchId = await generateId("SBATCH");
  const { schedule } = input;

  // Window columns are stored ONLY for the mode that uses them. Leaving a stale
  // 09:00-18:00 on a job the operator switched back to "run now" would make the
  // row lie about itself in the batches list, and the claim predicate reads
  // schedule_mode first — so the two would visibly disagree.
  const daily = schedule.mode === "daily";

  const rows = input.pairs.map((pair, idx) => ({
    id: `SJOB-${batchId.slice(-8)}-${String(idx).padStart(4, "0")}`,
    batch_id: batchId,
    seq: idx,
    query_text: pair.query,
    city: pair.city,
    max_results: pair.max_results,
    expand_with_ai: input.expandWithAi,
    status: "queued" as const,
    schedule_mode: schedule.mode,
    // run_after is a timestamptz and this is the one place a JS value becomes
    // one. It goes through the drizzle query builder (which binds it properly),
    // never through a raw sql`` template — a JS Date interpolated into a raw
    // template throws ERR_INVALID_ARG_TYPE at runtime on this driver.
    run_after:
      schedule.mode === "once" && schedule.run_after
        ? new Date(schedule.run_after)
        : null,
    window_start: daily ? (schedule.window_start ?? null) : null,
    window_end: daily ? (schedule.window_end ?? null) : null,
    window_days: daily ? (schedule.window_days ?? null) : null,
    created_by: input.userId,
  }));

  if (!rows.length) return { batchId, queued: 0 };

  await db.insert(scraperJobQueue).values(rows);

  return { batchId, queued: rows.length };
}

// ── dispatch ───────────────────────────────────────────────────────────────

// The window predicate, in SQL, as one expression.
//
// 'now'   — always eligible.
// 'once'  — eligible once run_after has passed. Fires once and is then done;
//           there is no repeat, which is what makes "single run" single.
// 'daily' — eligible while the IST clock is inside the window on a listed day.
//           This is the WHOLE recurrence model: a job outside its window is
//           simply not claimed, so it sits here until tomorrow and is picked up
//           then, day after day, until the batch is empty. Nothing pauses and
//           nothing resumes, so there is no pause/resume state to get wrong.
//
// The CASE is the overnight window (e.g. 22:00-06:00). When window_end is the
// smaller string the window wraps midnight, so membership is "at or after the
// start OR before the end" rather than BETWEEN. Storing two plain HH:MM strings
// keeps that decision in this one predicate instead of in the data.
//
// to_char(now() AT TIME ZONE 'Asia/Kolkata', 'dy') yields mon/tue/… — the same
// vocabulary as assignment_config.working_days and dialer_campaigns.window_days
// (E-120, E-228), which is why one reader can serve all three.
const ELIGIBLE = sql`(
  schedule_mode = 'now'
  OR (schedule_mode = 'once' AND run_after IS NOT NULL AND run_after <= now())
  OR (
    schedule_mode = 'daily'
    AND window_start IS NOT NULL
    AND window_end IS NOT NULL
    AND (
      window_days IS NULL
      OR window_days @> to_jsonb(
           lower(to_char(now() AT TIME ZONE 'Asia/Kolkata', 'dy'))
         )
    )
    AND CASE
          WHEN window_end > window_start
            THEN to_char(now() AT TIME ZONE 'Asia/Kolkata', 'HH24:MI')
                   >= window_start
             AND to_char(now() AT TIME ZONE 'Asia/Kolkata', 'HH24:MI')
                   <  window_end
          ELSE to_char(now() AT TIME ZONE 'Asia/Kolkata', 'HH24:MI')
                   >= window_start
            OR to_char(now() AT TIME ZONE 'Asia/Kolkata', 'HH24:MI')
                   <  window_end
        END
  )
)`;

interface ClaimedJob {
  id: string;
  query_text: string;
  city: string | null;
  max_results: number | null;
  expand_with_ai: boolean;
  created_by: string | null;
}

// Claim at most one job and start it. Returns null when there is nothing to do,
// which is the common case on most ticks.
export async function dispatchOnce(): Promise<{
  jobId: string;
  runId: string;
} | null> {
  // Clear out runs whose process died, so a crashed dispatch cannot wedge the
  // queue behind a row that will never reach a terminal status. Post-E-227 this
  // reaps on silence, so it will not touch a long run that is still working.
  await reapStuckRuns();

  // THE SERIAL GUARANTEE, and it is deliberately the same check
  // /api/scraper/run makes before starting a manual run. Both paths gate on
  // "is any run currently running", so a human clicking Run and the dispatcher
  // interleave rather than collide — one at a time, whoever gets there first.
  const [running] = await db
    .select({ id: scrapeRuns.id })
    .from(scrapeRuns)
    .where(eq(scrapeRuns.status, "running"))
    .limit(1);

  if (running) return null;

  // Claim in ONE statement. The inner SELECT ... FOR UPDATE SKIP LOCKED is the
  // real cross-process guard: the in-process `inFlight` flag on the ticker only
  // covers this node, but two nodes (or a node and the cron route) racing here
  // cannot claim the same row — the loser skips it and finds the next one.
  //
  // ORDER BY created_at, seq — in that order, deliberately. Every row of one
  // submission is inserted in a single statement and shares created_at exactly,
  // so this means "oldest batch first, and within it the operator's own row
  // order": batches drain one after another, FIFO. Leading with seq instead
  // would sort across batches (seq restarts at 0 per submission), so three
  // concurrent batches would round-robin and none would finish until nearly all
  // of them had.
  const claimedRows = (await db.execute<ClaimedJob>(sql`
    UPDATE scraper_job_queue
       SET status = 'running',
           dispatched_at = now(),
           attempts = attempts + 1
     WHERE id = (
       SELECT id
         FROM scraper_job_queue
        WHERE status = 'queued'
          AND ${ELIGIBLE}
        ORDER BY created_at, seq
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
    RETURNING id, query_text, city, max_results, expand_with_ai, created_by
  `)) as unknown as ClaimedJob[];

  const job = claimedRows[0];
  if (!job) return null;

  // From here the job is claimed, so every exit path must leave it in a
  // terminal state — a row stuck at 'running' with no run behind it would block
  // its batch forever, since reconcile has nothing to read.
  let runId: string;
  try {
    runId = await generateId("SCRAPE", scrapeRuns);

    // Same shape as the INSERT in /api/scraper/run, on purpose: the run must be
    // indistinguishable from a manually started one for the history list, the
    // progress poll and the cancel route.
    await db.insert(scrapeRuns).values({
      id: runId,
      search_queries: job.city
        ? `${job.query_text} in ${job.city}`
        : job.query_text,
      status: "running",
      triggered_by: job.created_by!,
      started_at: new Date(),
      total_chunks: 0,
      completed_chunks: 0,
    });

    await db
      .update(scraperJobQueue)
      .set({ run_id: runId })
      .where(eq(scraperJobQueue.id, job.id));
  } catch (err) {
    const message = sanitizeDbError(err) || "failed to create run";
    await db
      .update(scraperJobQueue)
      .set({
        status: "failed",
        last_error: message,
        finished_at: new Date(),
      })
      .where(eq(scraperJobQueue.id, job.id));
    console.error(`[SCRAPER][queue] job ${job.id} could not start`, err);
    return null;
  }

  try {
    await startChunkedRun(runId, job.query_text, {
      cities: job.city ? [job.city] : undefined,
      expandWithAi: job.expand_with_ai,
      maxResults: job.max_results,
    });
  } catch (err) {
    // startChunkedRun already called markRunFailed on its own way out; calling
    // it again is harmless and covers the case where the throw came from
    // somewhere it does not guard.
    const message = sanitizeDbError(err) || "startChunkedRun failed";
    await markRunFailed(runId, message).catch(() => {});
    await db
      .update(scraperJobQueue)
      .set({
        status: "failed",
        last_error: message,
        finished_at: new Date(),
      })
      .where(eq(scraperJobQueue.id, job.id));
    console.error(`[SCRAPER][queue] job ${job.id} fan-out failed`, err);
    return null;
  }

  console.log(
    `[SCRAPER][queue] dispatched job ${job.id} as run ${runId} — "${job.query_text}"${
      job.city ? ` in ${job.city}` : " (AI cities)"
    }`,
  );

  return { jobId: job.id, runId };
}

// ── reconcile ──────────────────────────────────────────────────────────────

// Copy terminal run status back onto the queue row. This is what makes batch
// progress true: without it a job stays 'running' forever, the batch never
// completes, and — worse — dispatchOnce would keep finding an empty queue while
// the UI showed work outstanding.
//
// Driven off the RUN's status rather than off any callback, because the run can
// end in four different places (finalize, chunk fan-out failure, user cancel,
// the reaper) and only one of them would ever think to tell the queue.
export async function reconcileFinishedJobs(): Promise<number> {
  const result = await db.execute(sql`
    UPDATE scraper_job_queue q
       SET status = CASE r.status
                      WHEN 'completed' THEN 'done'
                      WHEN 'cancelled' THEN 'cancelled'
                      ELSE 'failed'
                    END,
           leads_promoted = COALESCE(r.new_leads_promoted, 0),
           last_error = CASE WHEN r.status = 'completed'
                             THEN q.last_error
                             ELSE COALESCE(r.error_message, q.last_error)
                        END,
           finished_at = COALESCE(r.completed_at, now())
      FROM scraper_runs r
     WHERE q.run_id = r.id
       AND q.status = 'running'
       AND r.status IN ('completed', 'failed', 'cancelled')
  `);

  const count = (result as unknown as { count?: number })?.count ?? 0;
  if (count > 0) {
    console.log(`[SCRAPER][queue] reconciled ${count} finished job(s)`);
  }

  // Orphan sweep. The reconcile above joins on run_id, so a job that reached
  // 'running' WITHOUT one can never be settled by it — and that state is
  // reachable: dispatchOnce claims the row in one statement and writes run_id
  // in the next, so a process killed between the two (deploy, pm2 reload, OOM)
  // leaves a row that is permanently 'running' with nothing behind it. Because
  // dispatch is strictly serial, one such row does not just lose its own job —
  // it wedges the entire queue behind it forever.
  //
  // Also catches a run_id pointing at a scraper_runs row that is not there.
  //
  // One hour, and measured from dispatched_at in SQL, so this can never race a
  // job that is genuinely mid-flight: a live run has a row, and a run that died
  // was already force-failed by reapStuckRuns() twenty minutes in, which makes
  // it terminal and hands it to the reconcile above instead.
  const orphaned = await db.execute(sql`
    UPDATE scraper_job_queue q
       SET status = 'failed',
           last_error = COALESCE(
             q.last_error,
             'dispatch was interrupted before the run was recorded'
           ),
           finished_at = now()
     WHERE q.status = 'running'
       AND q.dispatched_at < now() - interval '1 hour'
       AND NOT EXISTS (
         SELECT 1 FROM scraper_runs r WHERE r.id = q.run_id
       )
  `);

  const orphanCount = (orphaned as unknown as { count?: number })?.count ?? 0;
  if (orphanCount > 0) {
    console.warn(
      `[SCRAPER][queue] released ${orphanCount} orphaned job(s) that were claimed but never ran`,
    );
  }

  return count + orphanCount;
}

// One tick of the dispatcher: settle what has finished, then start at most one
// new job. Reconcile FIRST — a job that finished during the last interval has
// to be off the books before we ask whether anything is running, or the queue
// stalls for a whole tick behind a run that is already over.
export async function runQueueTick(): Promise<{
  reconciled: number;
  dispatched: { jobId: string; runId: string } | null;
}> {
  const reconciled = await reconcileFinishedJobs();
  const dispatched = await dispatchOnce();
  return { reconciled, dispatched };
}

// ── cancel ─────────────────────────────────────────────────────────────────

// Cancels the QUEUED remainder of a batch only. A job already dispatched keeps
// running to completion — the same rule E-228 sets for a call already in
// flight, and the same one the window close obeys. Killing it here would throw
// away leads already fetched and paid for; the operator can still cancel that
// single run from Run History if they mean to.
export async function cancelBatch(
  batchId: string,
): Promise<{ cancelled: number; stillRunning: number }> {
  const cancelledRows = await db
    .update(scraperJobQueue)
    .set({
      status: "cancelled",
      last_error: "cancelled by user",
      finished_at: new Date(),
    })
    .where(
      and(
        eq(scraperJobQueue.batch_id, batchId),
        eq(scraperJobQueue.status, "queued"),
      ),
    )
    .returning({ id: scraperJobQueue.id });

  const [{ count: stillRunning }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(scraperJobQueue)
    .where(
      and(
        eq(scraperJobQueue.batch_id, batchId),
        eq(scraperJobQueue.status, "running"),
      ),
    );

  return { cancelled: cancelledRows.length, stillRunning: Number(stillRunning) };
}

// ── reads ──────────────────────────────────────────────────────────────────

export interface BatchSummary {
  batch_id: string;
  total: number;
  queued: number;
  running: number;
  done: number;
  failed: number;
  cancelled: number;
  leads_promoted: number;
  expand_with_ai: boolean;
  schedule_mode: ScheduleMode;
  run_after: string | null;
  window_start: string | null;
  window_end: string | null;
  window_days: Weekday[] | null;
  created_at: string;
  created_by: string | null;
  sample_query: string | null;
}

// Rolled up in SQL rather than by loading the jobs — a 500-job batch is 500
// rows the batches list has no use for, and this endpoint is polled while a
// batch drains.
//
// The schedule/expand columns come through min()/bool_or() because they are
// identical across every row of a batch by construction (enqueueBatch writes
// one submission's settings to all of its rows); an aggregate is just how you
// say "the batch's value" without a GROUP BY on seven more columns.
export async function listBatches(
  limit = 20,
  offset = 0,
): Promise<BatchSummary[]> {
  return (await db.execute<BatchSummary>(sql`
    SELECT batch_id,
           count(*)::int                                            AS total,
           count(*) FILTER (WHERE status = 'queued')::int            AS queued,
           count(*) FILTER (WHERE status = 'running')::int           AS running,
           count(*) FILTER (WHERE status = 'done')::int              AS done,
           count(*) FILTER (WHERE status = 'failed')::int            AS failed,
           count(*) FILTER (WHERE status = 'cancelled')::int         AS cancelled,
           COALESCE(sum(leads_promoted), 0)::int                     AS leads_promoted,
           bool_or(expand_with_ai)                                   AS expand_with_ai,
           min(schedule_mode)                                        AS schedule_mode,
           min(run_after)                                            AS run_after,
           min(window_start)                                         AS window_start,
           min(window_end)                                           AS window_end,
           (array_agg(window_days) FILTER (WHERE window_days IS NOT NULL))[1]
                                                                     AS window_days,
           min(created_at)                                           AS created_at,
           min(created_by::text)                                     AS created_by,
           (array_agg(
              CASE WHEN city IS NULL THEN query_text
                   ELSE query_text || ' in ' || city END
              ORDER BY seq))[1]                                      AS sample_query
      FROM scraper_job_queue
     GROUP BY batch_id
     ORDER BY min(created_at) DESC
     LIMIT ${limit} OFFSET ${offset}
  `)) as unknown as BatchSummary[];
}

export async function listBatchJobs(batchId: string) {
  return db
    .select()
    .from(scraperJobQueue)
    .where(eq(scraperJobQueue.batch_id, batchId))
    .orderBy(scraperJobQueue.seq);
}

// Used by the batch form to warn before submitting on top of a long backlog.
export async function countOutstandingJobs(): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(scraperJobQueue)
    .where(inArray(scraperJobQueue.status, ["queued", "running"]));
  return Number(row?.count ?? 0);
}

export async function latestBatchId(): Promise<string | null> {
  const [row] = await db
    .select({ batch_id: scraperJobQueue.batch_id })
    .from(scraperJobQueue)
    .orderBy(desc(scraperJobQueue.created_at))
    .limit(1);
  return row?.batch_id ?? null;
}
