import { after } from "next/server";
import { db } from "@/lib/db";
import { scrapeRuns } from "@/lib/db/schema";
import {
  generateId,
  withErrorHandler,
  successResponse,
  errorResponse,
} from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { startChunkedRun } from "@/lib/scraper/chunkedPipeline";
import { reapStuckRuns } from "@/lib/scraper/storage/runStore";
import { assertQStashConfigured } from "@/lib/queue/scheduler";
import { eq, desc } from "drizzle-orm";

export const maxDuration = 60;

export const POST = withErrorHandler(async (req: Request) => {
  const user = await requireRole(["sales_head", "ceo", "business_head"]);

  const body = await req.json();
  const baseQuery = body.query?.trim().toLowerCase();

  if (!baseQuery) {
    return errorResponse("Query is required", 400);
  }

  // Fail fast if QStash isn't configured — otherwise we'd insert a run row
  // that immediately becomes orphaned at status='running'.
  try {
    assertQStashConfigured();
  } catch (err: any) {
    return errorResponse(
      `Scraper queue not configured: ${err?.message ?? "unknown"}`,
      500,
    );
  }

  await reapStuckRuns();

  const running = await db
    .select({ id: scrapeRuns.id })
    .from(scrapeRuns)
    .where(eq(scrapeRuns.status, "running"))
    .limit(1)
    .then((res) => res[0]);

  if (running) {
    return errorResponse(`Scraper already running (ID: ${running.id})`, 409);
  }

  const runId = await generateId("SCRAPE", scrapeRuns);

  await db.insert(scrapeRuns).values({
    id: runId,
    search_queries: baseQuery,
    status: "running",
    triggered_by: user.id,
    started_at: new Date(),
    total_chunks: 0,
    completed_chunks: 0,
  });

  // Fan-out (AI query/city generation + QStash publishes) runs in the
  // background. Each chunk is dispatched as its own QStash message and
  // handled in a separate /api/scraper/chunk invocation, so a large run
  // no longer has to fit inside one serverless function's time budget.
  after(async () => {
    try {
      await startChunkedRun(runId, baseQuery);
    } catch (err) {
      console.error(`[scraper:run] fan-out failed for ${runId}`, err);
    }
  });

  return successResponse({ run_id: runId }, 202);
});

export const GET = withErrorHandler(async (req: Request) => {
  const { searchParams } = new URL(req.url);

  const page = Number(searchParams.get("page") || 1);
  const limit = 10;
  const offset = (page - 1) * limit;

  // Alias snake_case columns to camelCase for the UI — matches the convention
  // already used by /api/scraper/history. A bare select() returns the raw
  // Drizzle field names (snake_case post-schema migration), which the runs
  // table reads as undefined.
  const runs = await db
    .select({
      id: scrapeRuns.id,
      status: scrapeRuns.status,
      startedAt: scrapeRuns.started_at,
      completedAt: scrapeRuns.completed_at,
      totalFound: scrapeRuns.total_found,
      newLeadsSaved: scrapeRuns.new_leads_saved,
      duplicatesSkipped: scrapeRuns.duplicates_skipped,
      errorMessage: scrapeRuns.error_message,
      searchQueries: scrapeRuns.search_queries,
      triggeredBy: scrapeRuns.triggered_by,
      durationMs: scrapeRuns.duration_ms,
      totalChunks: scrapeRuns.total_chunks,
      completedChunks: scrapeRuns.completed_chunks,
    })
    .from(scrapeRuns)
    .orderBy(desc(scrapeRuns.started_at))
    .limit(limit)
    .offset(offset);

  return successResponse({
    data: runs,
    page,
  });
});
