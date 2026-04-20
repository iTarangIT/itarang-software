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
    searchQueries: query,
    status: "running",
    triggeredBy: userId,
    startedAt: new Date(),
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
      completedAt: new Date(),

      totalFound: stats.total,
      newLeadsSaved: stats.saved,
      duplicatesSkipped: stats.duplicates,
      cleanedLeads: stats.cleaned,
      durationMs: stats.duration_ms,
    })
    .where(eq(scrapeRuns.id, runId));
}

export async function markRunFailed(runId: string, error: string) {
  await db
    .update(scrapeRuns)
    .set({
      status: "failed",
      errorMessage: error,
      completedAt: new Date(),
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
      completedAt: new Date(),
      totalFound: stats.total,
      newLeadsSaved: stats.saved,
      duplicatesSkipped: stats.duplicates,
      cleanedLeads: stats.cleaned,
      durationMs: stats.duration_ms,
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
      errorMessage: "Run timed out (serverless function terminated)",
      completedAt: new Date(),
    })
    .where(
      and(eq(scrapeRuns.status, "running"), lt(scrapeRuns.startedAt, cutoff)),
    );
}
