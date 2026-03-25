/**
 * POST /api/scraper/run
 * Trigger scraper (fire-and-forget)
 */

import { db } from "@/lib/db";
import { scrapeRuns } from "@/lib/db/schema";
import {
  generateId,
  withErrorHandler,
  successResponse,
  errorResponse,
} from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { runDealerScraper } from "@/lib/dealer-scraper-service";
import { eq } from "drizzle-orm";

export const maxDuration = 300;

export const POST = withErrorHandler(async () => {
  const user = await requireRole(["sales_head", "ceo", "business_head"]);

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

  // Insert run
  await db.insert(scrapeRuns).values({
    id: runId,
    searchQueries: "EV battery dealers", 
    status: "running",
    triggeredBy: user.id,
    startedAt: new Date(),
  });

  // Background execution
  runDealerScraper(runId).catch((err) => {
    console.error(`[SCRAPER][${runId}] failed:`, err);
  });

  return successResponse(
    {
      run_id: runId,
      message: "Scraper started",
    },
    202,
  );
});
