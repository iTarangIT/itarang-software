// Calculator designer (Ecofy M08, CONFLICTS #31) — one release.
//
// GET   → the release bundle: params (values, segments, rules, texts),
//         appliances and standard systems.
// PATCH → edit a DRAFT's params / change note. Ecofy validates the fixed
//         9-step formula (FR-08.8) and answers 422 with the reason.
import { z } from "zod";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { ECOFY_MANAGER_ROLES } from "@/lib/ecofy/access";
import { ecofyActorName } from "@/lib/ecofy/queries";
import { EcofyCallError, patchCalcDraft, readCalcRelease } from "@/lib/ecofy/service";

export const dynamic = "force-dynamic";

function ecofyStatus(err: unknown): number {
    return err instanceof EcofyCallError ? (err.status >= 400 && err.status < 600 ? err.status : 502) : 500;
}

const PatchInput = z
    .object({
        params: z.record(z.string(), z.unknown()).optional(),
        changeNote: z.string().trim().max(500).optional(),
    })
    .refine((v) => v.params !== undefined || v.changeNote !== undefined, { message: "Nothing to save" });

type Ctx = { params: Promise<{ id: string }> };

export const GET = withErrorHandler(async (_req: Request, ctx: Ctx) => {
    await requireRole([...ECOFY_MANAGER_ROLES]);
    const { id } = await ctx.params;
    try {
        return successResponse(await readCalcRelease(id));
    } catch (err) {
        return errorResponse(err instanceof Error ? err.message : "Could not load the release from Ecofy", ecofyStatus(err));
    }
});

export const PATCH = withErrorHandler(async (req: Request, ctx: Ctx) => {
    const user = await requireRole([...ECOFY_MANAGER_ROLES]);
    const { id } = await ctx.params;
    const parsed = PatchInput.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return errorResponse(parsed.error.issues[0]?.message ?? "Invalid input", 400);
    try {
        return successResponse(await patchCalcDraft(id, parsed.data, ecofyActorName(user)));
    } catch (err) {
        return errorResponse(err instanceof Error ? err.message : "Ecofy could not save the draft", ecofyStatus(err));
    }
});
