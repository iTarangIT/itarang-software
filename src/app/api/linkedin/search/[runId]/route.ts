// LinkedIn Outreach — one search run: status and the scored shortlist.
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { LINKEDIN_ROLES } from "@/lib/linkedin/roles";
import { getRun, refreshRun } from "@/lib/linkedin/services/search";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async (_req: Request, { params }: { params: Promise<{ runId: string }> }) => {
  const { runId } = await params;
  await requireRole([...LINKEDIN_ROLES]);
  // A cheap progress check so the screen does not wait for the ticker.
  await refreshRun(runId).catch(() => undefined);
  const run = await getRun(runId);
  if (!run) return errorResponse("Search run not found", 404);
  return successResponse(run);
});
