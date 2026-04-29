/**
 * GET /api/scraper/history
 * List scraper runs (paginated)
 */

import { db } from "@/lib/db";
import { scrapeRuns } from "@/lib/db/schema";
import { withErrorHandler, successResponse } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { desc } from "drizzle-orm";

export const GET = withErrorHandler(async (req: Request) => {
  await requireRole(["sales_head", "ceo", "business_head"]);

  const { searchParams } = new URL(req.url);

  const limit = Math.min(Number(searchParams.get("limit")) || 20, 100);
  const offset = Number(searchParams.get("offset")) || 0;

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
    })
    .from(scrapeRuns)
    .orderBy(desc(scrapeRuns.started_at))
    .limit(limit)
    .offset(offset);

  return successResponse({
    runs,
    pagination: {
      limit,
      offset,
      count: runs.length,
    },
  });
});
