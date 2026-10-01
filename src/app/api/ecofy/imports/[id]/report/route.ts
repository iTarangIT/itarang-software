// Ecofy lead uploader — the row-level import report (GET
// /imports/{id}/report.csv; BRD FR-03.5 "the import report lists every row
// with its reason"). Managers only.
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, withErrorHandler } from "@/lib/api-utils";
import { ECOFY_MANAGER_ROLES } from "@/lib/ecofy/access";
import { proxyEcofyFile } from "@/lib/ecofy/fileProxy";
import { EcofyCallError, fetchEcofyImportFile } from "@/lib/ecofy/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = withErrorHandler(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    await requireRole([...ECOFY_MANAGER_ROLES]);
    const { id } = await ctx.params;
    try {
        const res = await fetchEcofyImportFile({ kind: "report", importId: id });
        return proxyEcofyFile(res, `ecofy-import-${id.slice(0, 8)}-report.csv`, "text/csv");
    } catch (err) {
        const status = err instanceof EcofyCallError && err.status >= 400 && err.status < 600 ? err.status : 502;
        return errorResponse(err instanceof Error ? err.message : "Could not download the import report from Ecofy", status);
    }
});
