import { db } from "@/lib/db";
import { scrapeRuns, scraperRunChunks } from "@/lib/db/schema";
import {
  withErrorHandler,
  successResponse,
  errorResponse,
} from "@/lib/api-utils";
import { eq, sql } from "drizzle-orm";

export const GET = withErrorHandler(
  async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;

    const [run] = await db
      .select({
        id: scrapeRuns.id,
        status: scrapeRuns.status,
        totalChunks: scrapeRuns.total_chunks,
        completedChunks: scrapeRuns.completed_chunks,
        totalFound: scrapeRuns.total_found,
        newLeadsSaved: scrapeRuns.new_leads_saved,
        duplicatesSkipped: scrapeRuns.duplicates_skipped,
        errorMessage: scrapeRuns.error_message,
        startedAt: scrapeRuns.started_at,
        completedAt: scrapeRuns.completed_at,
      })
      .from(scrapeRuns)
      .where(eq(scrapeRuns.id, id))
      .limit(1);

    if (!run) return errorResponse("Run not found", 404);

    const statusCounts = await db
      .select({
        status: scraperRunChunks.status,
        count: sql<number>`count(*)::int`,
        leadsSum: sql<number>`coalesce(sum(${scraperRunChunks.leads_count}), 0)::int`,
      })
      .from(scraperRunChunks)
      .where(eq(scraperRunChunks.run_id, id))
      .groupBy(scraperRunChunks.status);

    const breakdown = {
      pending: 0,
      running: 0,
      done: 0,
      failed: 0,
    };
    let rawLeadsFound = 0;
    for (const row of statusCounts) {
      if (row.status && row.status in breakdown) {
        breakdown[row.status as keyof typeof breakdown] = Number(row.count);
      }
      rawLeadsFound += Number(row.leadsSum);
    }

    const total = run.totalChunks ?? 0;
    const completed = run.completedChunks ?? 0;
    const percent = total > 0 ? Math.round((completed / total) * 100) : 0;

    return successResponse({
      id: run.id,
      status: run.status,
      totalChunks: total,
      completedChunks: completed,
      percent,
      breakdown,
      rawLeadsFound,
      totalFound: run.totalFound ?? 0,
      newLeadsSaved: run.newLeadsSaved ?? 0,
      duplicatesSkipped: run.duplicatesSkipped ?? 0,
      errorMessage: run.errorMessage,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
    });
  },
);
