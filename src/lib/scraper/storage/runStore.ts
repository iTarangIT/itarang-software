import { db } from "@/lib/db";
import { scrapeRuns } from "@/lib/db/schema";
import { and, eq, lt, sql } from "drizzle-orm";

// Legacy fallback threshold — total run age, used only where E-227's
// last_progress_at column is missing. See reapStuckRuns() below.
const STUCK_RUN_THRESHOLD_MS = 10 * 60 * 1000;

// E-227 reap-on-silence threshold. Generous on purpose: it is now measured
// from the last chunk that finished, not from the start of the run, so a
// 20-minute gap means the run really has stopped moving.
const SILENCE_THRESHOLD_MINUTES = 20;

const TIMEOUT_MESSAGE = "Run timed out (no chunk progress)";

// `last_progress_at` is E-227 and is NOT declared on the scrapeRuns drizzle
// object — deliberately, see the 26-line comment at schema.ts:~3246. It is
// therefore read and written only by raw sql``, and every such statement has
// to survive a database where E-227 has not been applied. We detect the
// undefined-column SQLSTATE once, latch it, and fall back for the rest of the
// process rather than paying a failed round-trip on every chunk.
//
// Drizzle wraps the driver error, so the pg error (and its `code`) lands on
// `.cause` — checking only the top-level `code` would silently never match.
let heartbeatColumnMissing = false;

function isUndefinedColumn(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "42703" || e?.cause?.code === "42703";
}

// Liveness heartbeat. Called by executeChunk() every time a chunk reaches a
// terminal state, so a long but healthy run keeps proving it is alive.
//
// Best-effort by construction: this is a SECOND statement, issued after the
// chunk accounting has already committed, so a database without E-227 loses
// the heartbeat and nothing else. Making it part of the counter bump would
// mean an unapplied E-227 stopped completed_chunks from advancing, and the
// run would never finalize — strictly worse than the reaper being coarse.
export async function touchRunProgress(runId: string) {
  if (heartbeatColumnMissing) return;
  try {
    await db.execute(
      sql`UPDATE scraper_runs SET last_progress_at = now() WHERE id = ${runId}`,
    );
  } catch (err) {
    if (!isUndefinedColumn(err)) {
      // Not a schema problem — a transient DB error on a heartbeat is not
      // worth failing the chunk over, but it should be visible.
      console.warn(`[SCRAPER][${runId}] progress heartbeat failed`, err);
      return;
    }
    heartbeatColumnMissing = true;
    console.warn(
      "[SCRAPER] scraper_runs.last_progress_at is missing — apply drizzle/E-227_scraper_multi_query.sql. " +
        "Until then long runs are reaped on total age (10m), not on silence.",
    );
  }
}

export async function markRunStarted(
  runId: string,
  query: string,
  userId: string,
) {
  await db.insert(scrapeRuns).values({
    id: runId,
    search_queries: query,
    status: "running",
    triggered_by: userId,
    started_at: new Date(),
  });
}

export async function markRunCompleted(
  runId: string,
  stats: {
    total: number;
    cleaned: number;
    saved: number;
    duplicates: number;
    duration_ms: number;
    // Optional dealer_leads promotion counts. Pre-existing callers (cancel
    // path, older code) can omit these; we default to nothing-changed.
    promoted?: number;
    skippedDuplicate?: number;
    skippedInvalidPhone?: number;
  },
  errorMessage?: string | null,
) {
  await db
    .update(scrapeRuns)
    .set({
      status: "completed",
      completed_at: new Date(),

      total_found: stats.total,
      new_leads_saved: stats.saved,
      duplicates_skipped: stats.duplicates,
      cleaned_leads: stats.cleaned,
      duration_ms: stats.duration_ms,
      // Only set promotion columns when caller provided them — leaves the
      // default 0 in place for runs that didn't track this.
      ...(stats.promoted !== undefined
        ? { new_leads_promoted: stats.promoted }
        : {}),
      ...(stats.skippedDuplicate !== undefined
        ? { new_leads_skipped_duplicate: stats.skippedDuplicate }
        : {}),
      ...(stats.skippedInvalidPhone !== undefined
        ? { new_leads_skipped_invalid_phone: stats.skippedInvalidPhone }
        : {}),
      // Persist a representative chunk-error when finalize completed with zero
      // leads — otherwise UI shows "Completed, 0 leads" with no reason. Pass
      // null/undefined to skip.
      ...(errorMessage ? { error_message: errorMessage } : {}),
    })
    .where(eq(scrapeRuns.id, runId));
}

export async function markRunFailed(runId: string, error: string) {
  await db
    .update(scrapeRuns)
    .set({
      status: "failed",
      error_message: error,
      completed_at: new Date(),
    })
    .where(eq(scrapeRuns.id, runId));
}

export async function markRunCancelled(
  runId: string,
  stats: {
    total: number;
    cleaned: number;
    saved: number;
    duplicates: number;
    duration_ms: number;
  },
) {
  await db
    .update(scrapeRuns)
    .set({
      status: "cancelled",
      completed_at: new Date(),
      total_found: stats.total,
      new_leads_saved: stats.saved,
      duplicates_skipped: stats.duplicates,
      cleaned_leads: stats.cleaned,
      duration_ms: stats.duration_ms,
    })
    .where(eq(scrapeRuns.id, runId));
}

// Serverless functions can be terminated before the scraper finishes, leaving
// rows stuck at status='running' forever. Reap any that have gone quiet.
//
// This reaps on SILENCE, not on total run age. The original version failed any
// run whose started_at was more than 10 minutes old, which was survivable while
// every run came from a human clicking Run and finished in a couple of minutes.
// E-241's dispatcher calls this on every 30s tick, and a batch job with AI
// expansion fans out to ~15 chunks that legitimately take longer than that — so
// age-based reaping would kill a perfectly healthy run at minute 11 and then
// immediately claim the next queued job on top of it.
//
// COALESCE(last_progress_at, started_at) is what makes both true at once: a run
// that keeps completing chunks keeps pushing its own cutoff forward, and a run
// that dies before its first chunk still falls back to started_at and is reaped.
//
// The comparison is against Postgres now() rather than a JS Date — the rule
// src/lib/nbfc/auction/scheduler.ts records after clock skew on the pm2 VPS.
export async function reapStuckRuns() {
  if (!heartbeatColumnMissing) {
    try {
      await db.execute(sql`
        UPDATE scraper_runs
           SET status = 'failed',
               error_message = ${TIMEOUT_MESSAGE},
               completed_at = now()
         WHERE status = 'running'
           AND COALESCE(last_progress_at, started_at)
                 < now() - (${SILENCE_THRESHOLD_MINUTES}::text || ' minutes')::interval
      `);
      return;
    } catch (err) {
      if (!isUndefinedColumn(err)) throw err;
      heartbeatColumnMissing = true;
      console.warn(
        "[SCRAPER] scraper_runs.last_progress_at is missing — apply drizzle/E-227_scraper_multi_query.sql. " +
          "Falling back to age-based reaping, which can kill long batch runs.",
      );
    }
  }

  // Pre-E-227 behaviour, unchanged.
  const cutoff = new Date(Date.now() - STUCK_RUN_THRESHOLD_MS);

  await db
    .update(scrapeRuns)
    .set({
      status: "failed",
      error_message: "Run timed out (serverless function terminated)",
      completed_at: new Date(),
    })
    .where(
      and(eq(scrapeRuns.status, "running"), lt(scrapeRuns.started_at, cutoff)),
    );
}
