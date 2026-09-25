// E-307 — active ASMs and ISRs the Sales Head can hand an Ecofy lead to.
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { ECOFY_MANAGER_ROLES } from "@/lib/ecofy/access";
import { listEcofyAssignees } from "@/lib/ecofy/assignment";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async () => {
    await requireRole([...ECOFY_MANAGER_ROLES]);
    return successResponse({ assignees: await listEcofyAssignees() });
});
