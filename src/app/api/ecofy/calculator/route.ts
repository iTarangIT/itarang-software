// E-307 — the Ecofy energy calculator from the CRM.
//
// GET  → the published release (appliance catalogue, per-segment inputs).
// POST → a quick estimate; Ecofy computes it on its published release and
//        stores nothing. Same audience as the rest of the Ecofy workspace.
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { ECOFY_ALL_ROLES } from "@/lib/ecofy/access";
import { ecofyCalcInputSchema } from "@/lib/ecofy/actionSchemas";
import { EcofyCallError, readCalculatorRelease, runCalculatorEstimate } from "@/lib/ecofy/service";

export const dynamic = "force-dynamic";

// CalcInput — shared with the CALCULATOR assessment (actionSchemas.ts); Ecofy validates again.
const EstimateInput = ecofyCalcInputSchema;

function ecofyStatus(err: unknown): number {
    return err instanceof EcofyCallError ? (err.status >= 400 && err.status < 600 ? err.status : 502) : 500;
}

export const GET = withErrorHandler(async () => {
    await requireRole([...ECOFY_ALL_ROLES]);
    try {
        return successResponse(await readCalculatorRelease());
    } catch (err) {
        return errorResponse(err instanceof Error ? err.message : "Could not load the calculator from Ecofy", ecofyStatus(err));
    }
});

export const POST = withErrorHandler(async (req: Request) => {
    await requireRole([...ECOFY_ALL_ROLES]);
    const parsed = EstimateInput.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
        const first = parsed.error.issues[0];
        return errorResponse(`Invalid calculator input${first ? `: ${first.path.join(".")} ${first.message}` : ""}`, 400);
    }
    try {
        return successResponse(await runCalculatorEstimate(parsed.data));
    } catch (err) {
        return errorResponse(err instanceof Error ? err.message : "Ecofy could not compute the estimate", ecofyStatus(err));
    }
});
