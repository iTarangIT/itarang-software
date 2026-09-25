// POST /api/dashboard/ceo/news/refresh — the card's Refresh button (E-306).
// CEO only. Forces a run, but not more than once every 15 minutes: the feeds
// do not change faster than that and each run costs Gemini calls.

import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { lastOkRunAt } from "@/lib/news/queries";
import { runGreenNewsRefresh } from "@/lib/news/run";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MANUAL_MIN_GAP_MS = 15 * 60 * 1000;

export const POST = withErrorHandler(async () => {
  await requireRole(["ceo"]);

  const last = await lastOkRunAt();
  if (last && Date.now() - last.getTime() < MANUAL_MIN_GAP_MS) {
    const mins = Math.ceil((MANUAL_MIN_GAP_MS - (Date.now() - last.getTime())) / 60_000);
    return errorResponse(`Refreshed recently — try again in ${mins} min`, 429);
  }

  const result = await runGreenNewsRefresh({ triggeredBy: "manual", force: true });
  if (result.reason === "disabled") return errorResponse("The news feed is switched off in settings", 409);
  if (result.reason === "failed") return errorResponse(result.error ?? "Refresh failed", 500);
  return successResponse(result);
});
