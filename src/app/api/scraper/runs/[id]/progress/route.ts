import { db } from "@/lib/db";
import { scrapeRuns, scraperRunChunks } from "@/lib/db/schema";
import {
  withErrorHandler,
  successResponse,
  errorResponse,
} from "@/lib/api-utils";
import { and, eq, isNotNull, sql } from "drizzle-orm";

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
        newLeadsPromoted: scrapeRuns.new_leads_promoted,
        newLeadsSkippedDuplicate: scrapeRuns.new_leads_skipped_duplicate,
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

    // When chunks fail, the actual reason lives on the chunk row, not the run.
    // Surface a representative chunk error so the UI can show *why* the run
    // produced no leads instead of just "Failed: N".
    let chunkErrorSample: string | null = null;
    let chunkErrorCount = 0;
    if (breakdown.failed > 0) {
      const errorRows = await db
        .select({
          message: scraperRunChunks.error_message,
          count: sql<number>`count(*)::int`,
        })
        .from(scraperRunChunks)
        .where(
          and(
            eq(scraperRunChunks.run_id, id),
            eq(scraperRunChunks.status, "failed"),
            isNotNull(scraperRunChunks.error_message),
          ),
        )
        .groupBy(scraperRunChunks.error_message)
        .orderBy(sql`count(*) desc`)
        .limit(1);
      if (errorRows[0]) {
        chunkErrorSample = errorRows[0].message;
        chunkErrorCount = Number(errorRows[0].count);
      }
    }

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
      // Pass through nullable so the UI can distinguish "0 promoted, this is
      // the alarm-bell case" from "old run before tracking existed, fall back
      // to legacy view". DB default is 0 for new runs, NULL for old runs.
      newLeadsPromoted: run.newLeadsPromoted,
      newLeadsSkippedDuplicate: run.newLeadsSkippedDuplicate,
      errorMessage: run.errorMessage,
      chunkErrorSample,
      chunkErrorCount,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
    });
  },
);
