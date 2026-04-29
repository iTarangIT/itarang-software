import { db } from "@/lib/db";
import { scrapeRuns } from "@/lib/db/schema";
import { and, eq, lt } from "drizzle-orm";

const STUCK_RUN_THRESHOLD_MS = 10 * 60 * 1000;

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
  },
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
// rows stuck at status='running' forever. Reap any that exceed the threshold.
export async function reapStuckRuns() {
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
