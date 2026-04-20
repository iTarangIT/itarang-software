import {
  withErrorHandler,
  successResponse,
  errorResponse,
} from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { cancelChunkedRun } from "@/lib/scraper/chunkedPipeline";

export const maxDuration = 60;

export const POST = withErrorHandler(
  async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
    await requireRole(["sales_head", "ceo", "business_head"]);

    const { id } = await params;

    if (!id) {
      return errorResponse("Run id required", 400);
    }

    const result = await cancelChunkedRun(id);

    if (result.alreadyTerminal) {
      return errorResponse(
        `Run is already ${result.status} — cannot cancel`,
        409,
      );
    }

    return successResponse({
      cancelled: true,
      saved: result.saved,
      total: result.total,
    });
  },
);
