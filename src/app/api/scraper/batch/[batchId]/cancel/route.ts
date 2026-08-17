import { withErrorHandler, successResponse, errorResponse } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { cancelBatch } from "@/lib/scraper/jobQueue";

// E-241 — POST /api/scraper/batch/[batchId]/cancel
//
// Cancels the QUEUED remainder of a batch. A job already dispatched keeps
// running to completion — the same rule the closing window obeys, and the same
// one E-228 sets for a call already in flight. Killing it here would throw away
// leads that have already been fetched and paid for; the operator can still
// cancel that one run from Run History if they mean to.

export const dynamic = "force-dynamic";

export const POST = withErrorHandler(
  async (_req: Request, context: { params: Promise<{ batchId: string }> }) => {
    await requireRole(["sales_head", "ceo", "business_head"]);

    const { batchId } = await context.params;
    if (!batchId) return errorResponse("batchId is required", 400);

    const { cancelled, stillRunning } = await cancelBatch(batchId);

    return successResponse({
      batch_id: batchId,
      cancelled,
      // Surfaced so the UI can say "1 job is still finishing" instead of
      // implying everything stopped the moment the button was pressed.
      still_running: stillRunning,
    });
  },
);
