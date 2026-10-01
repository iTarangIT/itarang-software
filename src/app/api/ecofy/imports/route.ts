// Ecofy lead uploader — bulk import, step 1 (M03, tracker ID 51 gap 11).
//
// multipart/form-data:
//   file   the lead file (.xlsx or .csv, ≤ 10 MB — OpenAPI ImportStart)
//
// The server starts the import in Ecofy (POST /imports → UploadTicket), PUTs
// the bytes to the presigned URL, and reads the header row so the wizard can
// show the column mapping (BRD FR-03.2/FR-03.3). The browser never talks to
// Ecofy or its storage. Managers only (Sales Head, CEO = iTarang Admin).
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { ECOFY_MANAGER_ROLES } from "@/lib/ecofy/access";
import { readImportHeaders } from "@/lib/ecofy/importHeaders";
import { checkImportFile, defaultImportMapping, LEAD_TEMPLATE_COLUMNS, LEAD_TEMPLATE_REQUIRED } from "@/lib/ecofy/intake";
import { ecofyActorName } from "@/lib/ecofy/queries";
import { EcofyCallError, startEcofyImport } from "@/lib/ecofy/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function ecofyStatus(err: unknown): number {
    return err instanceof EcofyCallError ? (err.status >= 400 && err.status < 600 ? err.status : 502) : 500;
}

const MIME_BY_EXT: Record<string, string> = {
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    csv: "text/csv",
};

export const POST = withErrorHandler(async (req: Request) => {
    const user = await requireRole([...ECOFY_MANAGER_ROLES]);
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return errorResponse("Choose the lead file", 400);
    const bad = checkImportFile(file.name, file.size);
    if (bad) return errorResponse(bad, 400);

    const bytes = Buffer.from(await file.arrayBuffer());
    let headers: string[];
    try {
        headers = readImportHeaders(bytes);
    } catch {
        return errorResponse("Could not read the file — save it as .xlsx or .csv and try again", 400);
    }
    if (headers.length === 0) return errorResponse("The file has no header row", 400);

    const ext = file.name.toLowerCase().split(".").pop() ?? "";
    try {
        const ticket = await startEcofyImport(
            { bytes, fileName: file.name, mimeType: file.type || MIME_BY_EXT[ext] || "application/octet-stream" },
            ecofyActorName(user),
        );
        return successResponse(
            {
                importId: ticket.id,
                fileName: file.name,
                headers,
                suggestedMapping: defaultImportMapping(headers),
                templateColumns: LEAD_TEMPLATE_COLUMNS,
                requiredColumns: LEAD_TEMPLATE_REQUIRED,
            },
            201,
        );
    } catch (err) {
        return errorResponse(err instanceof Error ? err.message : "Ecofy could not start the import", ecofyStatus(err));
    }
});
