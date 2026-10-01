// E-307 — who held this Ecofy lead, when, and why it moved.
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { ECOFY_ALL_ROLES } from "@/lib/ecofy/access";
import { listAssignmentHistory } from "@/lib/ecofy/assignment";
import { getEcofyLeadForViewer } from "@/lib/ecofy/queries";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const user = await requireRole([...ECOFY_ALL_ROLES]);
    const { id } = await ctx.params;
    const lead = await getEcofyLeadForViewer(id, user);
    return successResponse({ history: [...(await listAssignmentHistory(lead.id))] });
});
