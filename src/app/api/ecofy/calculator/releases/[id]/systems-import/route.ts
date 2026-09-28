// Calculator designer (Ecofy M08, CONFLICTS #31) — import the standard-systems
// template (v0.2, .xlsx or .csv) into a DRAFT.
//
// multipart/form-data:
//   file        the template (≤ 10 MB)
//   replaceAll  "true" to drop every existing system first
//
// The server uploads the file to Ecofy as a document and calls the import, so
// the browser never talks to Ecofy. Rows Ecofy refuses come back with reasons.
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { ECOFY_MANAGER_ROLES } from "@/lib/ecofy/access";
import { ecofyActorName } from "@/lib/ecofy/queries";
import { EcofyCallError, importCalcSystems } from "@/lib/ecofy/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_EXT = /\.(xlsx|xls|csv)$/i;

function ecofyStatus(err: unknown): number {
    return err instanceof EcofyCallError ? (err.status >= 400 && err.status < 600 ? err.status : 502) : 500;
}

export const POST = withErrorHandler(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const user = await requireRole([...ECOFY_MANAGER_ROLES]);
    const { id } = await ctx.params;

    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) return errorResponse("Choose the systems template file", 400);
    if (file.size > MAX_BYTES) return errorResponse("Max 10 MB", 400);
    if (!ALLOWED_EXT.test(file.name)) return errorResponse("Upload the template as .xlsx or .csv", 400);
    const replaceAll = form.get("replaceAll") === "true";

    try {
        const result = await importCalcSystems(
            id,
            {
                bytes: Buffer.from(await file.arrayBuffer()),
                fileName: file.name,
                mimeType: file.type || "application/octet-stream",
            },
            replaceAll,
            ecofyActorName(user),
        );
        return successResponse(result);
    } catch (err) {
        return errorResponse(err instanceof Error ? err.message : "Ecofy could not import the systems", ecofyStatus(err));
    }
});
