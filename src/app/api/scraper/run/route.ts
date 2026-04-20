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
    searchQueries: baseQuery,
    status: "running",
    triggeredBy: user.id,
    startedAt: new Date(),
    totalChunks: 0,
    completedChunks: 0,
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

  const runs = await db
    .select()
    .from(scrapeRuns)
    .orderBy(desc(scrapeRuns.startedAt))
    .limit(limit)
    .offset(offset);

  return successResponse({
    data: runs,
    page,
  });
});
