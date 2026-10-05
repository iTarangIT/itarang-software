// Ecofy lead uploader — download the lead upload template v0.3 from Ecofy
// (GET /imports/template; BRD FR-03.1). Managers only.
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, withErrorHandler } from "@/lib/api-utils";
import { ECOFY_MANAGER_ROLES } from "@/lib/ecofy/access";
import { proxyEcofyFile } from "@/lib/ecofy/fileProxy";
import { EcofyCallError, fetchEcofyImportFile } from "@/lib/ecofy/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = withErrorHandler(async () => {
    await requireRole([...ECOFY_MANAGER_ROLES]);
    try {
        const res = await fetchEcofyImportFile({ kind: "template" });
        return proxyEcofyFile(
            res,
            "Ecofy_Lead_Upload_Template_v0.3.xlsx",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        );
    } catch (err) {
        const status = err instanceof EcofyCallError && err.status >= 400 && err.status < 600 ? err.status : 502;
        return errorResponse(err instanceof Error ? err.message : "Could not download the template from Ecofy", status);
    }
});
