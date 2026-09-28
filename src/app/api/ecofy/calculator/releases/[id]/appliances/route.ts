// Calculator designer (Ecofy M08, CONFLICTS #31) — replace a DRAFT's appliance catalogue.
import { z } from "zod";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { ECOFY_MANAGER_ROLES } from "@/lib/ecofy/access";
import { ecofyActorName } from "@/lib/ecofy/queries";
import { EcofyCallError, putCalcAppliances } from "@/lib/ecofy/service";

export const dynamic = "force-dynamic";

function ecofyStatus(err: unknown): number {
    return err instanceof EcofyCallError ? (err.status >= 400 && err.status < 600 ? err.status : 502) : 500;
}

// Mirrors Ecofy's ApplianceIn (m08-calc-designer/schemas.ts); Ecofy validates again.
const ApplianceInput = z.object({
    name: z.string().trim().min(2).max(80),
    defaultWatts: z.number().int().min(1),
    isMotor: z.boolean(),
    startMultiplier: z.number().min(1).max(8),
    sortOrder: z.number().int().optional(),
    active: z.boolean().optional(),
});

export const PUT = withErrorHandler(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const user = await requireRole([...ECOFY_MANAGER_ROLES]);
    const { id } = await ctx.params;
    const parsed = z.array(ApplianceInput).max(200).safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
        const first = parsed.error.issues[0];
        return errorResponse(`Invalid appliance${first ? `: ${first.path.join(".")} ${first.message}` : ""}`, 400);
    }
    try {
        await putCalcAppliances(id, parsed.data, ecofyActorName(user));
        return successResponse({ count: parsed.data.length });
    } catch (err) {
        return errorResponse(err instanceof Error ? err.message : "Ecofy could not save the appliances", ecofyStatus(err));
    }
});
