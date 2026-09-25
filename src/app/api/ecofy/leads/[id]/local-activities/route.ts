// E-308 — calls / remarks / follow-ups / meetings recorded in the CRM for an
// Ecofy lead, with their sync-to-Ecofy status.
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { ECOFY_ALL_ROLES } from "@/lib/ecofy/access";
import { listLocalActivities } from "@/lib/ecofy/localActivities";
import { getEcofyLeadForViewer } from "@/lib/ecofy/queries";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const user = await requireRole([...ECOFY_ALL_ROLES]);
    const { id } = await ctx.params;
    const lead = await getEcofyLeadForViewer(id, user);
    return successResponse({ activities: await listLocalActivities(lead.id) });
});
