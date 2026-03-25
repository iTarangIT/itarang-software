import { db } from "@/lib/db";
import { scrapeRuns } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

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
    saved: number;
    duplicates: number;
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
