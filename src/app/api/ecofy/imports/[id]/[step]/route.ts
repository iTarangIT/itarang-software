// Ecofy lead uploader — bulk import steps 2–4 (M03, tracker ID 51 gap 11).
//
//   POST mapping   {mapping: sourceHeader → template column, saveAs?}  → Import
//   POST validate  (no body) → ImportPreview: counts + sample row errors
//   POST commit    {consentAttested: true, attestationText, idempotencyKey} → Import
//
// Shapes follow OpenAPI ImportMapping / ImportPreview / ImportCommit; commit
// carries the required Idempotency-Key. Every step is a write in
// ecofy_sync_events. Managers only (Sales Head, CEO = iTarang Admin).
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { ECOFY_MANAGER_ROLES } from "@/lib/ecofy/access";
import { importCommitSchema, importMappingSchema } from "@/lib/ecofy/intake";
import { ecofyActorName } from "@/lib/ecofy/queries";
import { commitEcofyImport, EcofyCallError, saveEcofyImportMapping, validateEcofyImport } from "@/lib/ecofy/service";

export const dynamic = "force-dynamic";

function ecofyStatus(err: unknown): number {
    return err instanceof EcofyCallError ? (err.status >= 400 && err.status < 600 ? err.status : 502) : 500;
}

function invalid(what: string, issues: Array<{ path: PropertyKey[]; message: string }>) {
    const first = issues[0];
    return errorResponse(`Invalid ${what}${first ? `: ${first.path.map(String).join(".") || "input"} — ${first.message}` : ""}`, 400);
}

export const POST = withErrorHandler(async (req: Request, ctx: { params: Promise<{ id: string; step: string }> }) => {
    const user = await requireRole([...ECOFY_MANAGER_ROLES]);
    const { id, step } = await ctx.params;
    const actorName = ecofyActorName(user);
    try {
        switch (step) {
            case "mapping": {
                const parsed = importMappingSchema.safeParse(await req.json().catch(() => null));
                if (!parsed.success) return invalid("mapping", parsed.error.issues);
                return successResponse(await saveEcofyImportMapping(id, parsed.data, actorName));
            }
            case "validate":
                return successResponse(await validateEcofyImport(id, actorName));
            case "commit": {
                const parsed = importCommitSchema.safeParse(await req.json().catch(() => null));
                if (!parsed.success) return invalid("commit", parsed.error.issues);
                return successResponse(
                    await commitEcofyImport(id, parsed.data.attestationText, parsed.data.idempotencyKey, actorName),
                    202,
                );
            }
            default:
                return errorResponse("Unknown import step", 404);
        }
    } catch (err) {
        return errorResponse(err instanceof Error ? err.message : "Ecofy could not run this import step", ecofyStatus(err));
    }
});
