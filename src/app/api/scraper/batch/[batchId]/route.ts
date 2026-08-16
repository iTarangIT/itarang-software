import { withErrorHandler, successResponse, errorResponse } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { listBatchJobs } from "@/lib/scraper/jobQueue";

// E-241 — GET /api/scraper/batch/[batchId]
//
// The per-job rows of one batch, in dispatch order. Separate from the batch
// list because that list is polled while work drains and a 500-job batch is 500
// rows it has no use for — these are only fetched when a row is expanded.

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(
  async (_req: Request, context: { params: Promise<{ batchId: string }> }) => {
    await requireRole(["sales_head", "ceo", "business_head"]);

    const { batchId } = await context.params;
    if (!batchId) return errorResponse("batchId is required", 400);

    const jobs = await listBatchJobs(batchId);
    if (!jobs.length) return errorResponse("Batch not found", 404);

    return successResponse({ batch_id: batchId, jobs });
  },
);
