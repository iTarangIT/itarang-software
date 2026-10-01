// GET /api/inside-sales/lead/[id]/ai-calls
// The lead page's AI Call History tab: every AI call attempt for this lead —
// campaign attempts AND one-off Bolna / ElevenLabs calls from the leads list,
// which belong to no campaign and so never reached the campaign transcript
// endpoint the tab used to read.
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { loadLeadCallAttempts } from "@/lib/ai-dialer/leadCallAttempts";

export const dynamic = "force-dynamic";

// Same readers as the lead detail bundle (../route.ts).
const READ_ROLES = [
    "inside_sales_rep",
    "asm",
    "admin",
    "ceo",
    "sales_manager",
    "sales_head",
    "business_head",
    "partner",
];

export const GET = withErrorHandler(
    async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
        await requireRole(READ_ROLES);
        const { id } = await ctx.params;
        if (!id) return errorResponse("Lead id required", 400);
        return successResponse(await loadLeadCallAttempts({ leadId: id, includeOneOff: true }));
    },
);
