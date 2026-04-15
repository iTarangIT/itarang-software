/**
 * GET /api/scraper/history
 * List scraper runs (paginated)
 */

import { db } from "@/lib/db";
import { scraperRuns } from "@/lib/db/schema";
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
      id: scraperRuns.id,
      status: scraperRuns.status,
      startedAt: scraperRuns.started_at,
      completedAt: scraperRuns.completed_at,
      totalFound: scraperRuns.total_found,
      newLeadsSaved: scraperRuns.new_leads_saved,
      duplicatesSkipped: scraperRuns.duplicates_skipped,
      errorMessage: scraperRuns.error_message,
    })
    .from(scraperRuns)
    .orderBy(desc(scraperRuns.started_at))
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
