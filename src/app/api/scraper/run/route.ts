import { db } from "@/lib/db";
import { scrapeRuns } from "@/lib/db/schema";
import {
  generateId,
  withErrorHandler,
  successResponse,
  errorResponse,
} from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { runDealerScraper } from "@/lib/scraper/pipeline";
import { eq, desc } from "drizzle-orm";

export const maxDuration = 300;

export const POST = withErrorHandler(async (req: Request) => {
  const user = await requireRole(["sales_head", "ceo", "business_head"]);

  const body = await req.json();
  const baseQuery = body.query?.trim().toLowerCase();

  if (!baseQuery) {
    return errorResponse("Query is required", 400);
  }

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
  });

  runDealerScraper(runId, baseQuery).catch(console.error);

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