// GET /api/admin/escalations/[id] — escalation resolution thread (BRD §0.6):
// the escalation, its lead summary, and the full touchpoint + status history.

import { NextRequest } from "next/server";
import { requireRole } from "@/lib/auth-utils";
import {
    errorResponse,
    successResponse,
    withErrorHandler,
} from "@/lib/api-utils";
import { fetchEscalationThread } from "@/lib/admin/listQueries";

export const dynamic = "force-dynamic";

const READ_ROLES = ["admin", "sales_head", "ceo"];

export const GET = withErrorHandler(
    async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
        await requireRole(READ_ROLES);
        const { id } = await ctx.params;
        if (!id) return errorResponse("Escalation id required.", 400);

        const thread = await fetchEscalationThread(id);
        if (!thread) return errorResponse("Escalation not found.", 404);

        return successResponse(thread);
    },
);
