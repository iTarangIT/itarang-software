// E-307 — sidebar badge counts for the Ecofy workspace. Sales Head: the
// pickup queue; ASM / ISR: their own open leads and follow-ups due. Local
// table only — never calls Ecofy, so a slow Ecofy never slows the sidebar.
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { ECOFY_ALL_ROLES } from "@/lib/ecofy/access";
import { ecofyCounts } from "@/lib/ecofy/queries";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async () => {
    const user = await requireRole([...ECOFY_ALL_ROLES]);
    return successResponse(await ecofyCounts(user));
});
