/**
 * GET /api/scraper/status?runId=...
 */

import { db } from "@/lib/db";
import { scrapeRuns } from "@/lib/db/schema";
import {
  withErrorHandler,
  successResponse,
  errorResponse,
} from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { eq } from "drizzle-orm";

export const GET = withErrorHandler(async (req: Request) => {
  await requireRole(["sales_head", "ceo", "business_head"]);

  const { searchParams } = new URL(req.url);
  const runId = searchParams.get("runId");

  if (!runId) {
    return errorResponse("runId is required", 400);
  }

  const run = await db
    .select()
    .from(scrapeRuns)
    .where(eq(scrapeRuns.id, runId))
    .limit(1)
    .then((res) => res[0]);

  if (!run) {
    return errorResponse("Run not found", 404);
  }

  return successResponse(run);
});
