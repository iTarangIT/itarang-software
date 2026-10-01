// Ecofy lead uploader — single lead (M03, tracker ID 51 gap 11).
//
// POST → Ecofy POST /cases (CaseCreate) with the browser's Idempotency-Key,
//        as the integration user (iTarang Admin): the case starts at S1,
//        owned by iTarang (OpenAPI CaseCreate; BRD FR-03.8). The returned Case
//        is upserted into ecofy_leads so it is in the pickup queue at once.
//        The write is in ecofy_sync_events (outbound api:POST /cases).
//
// Managers only (Sales Head, CEO): intake is iTarang Admin work in Ecofy.
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { ECOFY_MANAGER_ROLES } from "@/lib/ecofy/access";
import { crmCaseCreateSchema } from "@/lib/ecofy/intake";
import { ecofyActorName } from "@/lib/ecofy/queries";
import { createEcofyCase, EcofyCallError } from "@/lib/ecofy/service";

export const dynamic = "force-dynamic";

function ecofyStatus(err: unknown): number {
    return err instanceof EcofyCallError ? (err.status >= 400 && err.status < 600 ? err.status : 502) : 500;
}

export const POST = withErrorHandler(async (req: Request) => {
    const user = await requireRole([...ECOFY_MANAGER_ROLES]);
    const parsed = crmCaseCreateSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
        const first = parsed.error.issues[0];
        return errorResponse(`Invalid lead${first ? `: ${first.path.join(".") || "input"} — ${first.message}` : ""}`, 400);
    }
    const { idempotencyKey, ...input } = parsed.data;
    try {
        const { case: kase, leadId } = await createEcofyCase(input, idempotencyKey, ecofyActorName(user));
        return successResponse(
            { caseId: kase.id, caseNo: kase.caseNo ?? null, stage: kase.stage ?? null, owner: kase.owner ?? null, leadId },
            201,
        );
    } catch (err) {
        return errorResponse(err instanceof Error ? err.message : "Ecofy could not create the lead", ecofyStatus(err));
    }
});
