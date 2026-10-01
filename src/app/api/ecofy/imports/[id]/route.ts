// Ecofy lead uploader — import status (GET /imports/{id}). The wizard polls it
// after commit until COMMITTED or FAILED (the commit is a background job,
// BRD FR-03.5). Managers only.
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { ECOFY_MANAGER_ROLES } from "@/lib/ecofy/access";
import { EcofyCallError, readEcofyImport } from "@/lib/ecofy/service";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    await requireRole([...ECOFY_MANAGER_ROLES]);
    const { id } = await ctx.params;
    try {
        return successResponse(await readEcofyImport(id));
    } catch (err) {
        const status = err instanceof EcofyCallError && err.status >= 400 && err.status < 600 ? err.status : 502;
        return errorResponse(err instanceof Error ? err.message : "Could not load the import from Ecofy", status);
    }
});
