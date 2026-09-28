// Calculator designer (Ecofy M08, CONFLICTS #31) — releases from the CRM.
//
// GET  → every calculator release in Ecofy (draft, pending, published, retired).
// POST → a new draft copied from the published release (Ecofy allows one open
//        draft at a time and answers 422 when one exists).
// Sales Head / CEO only: this is iTarang-Admin work in Ecofy's role matrix.
import { z } from "zod";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { ECOFY_MANAGER_ROLES } from "@/lib/ecofy/access";
import { ecofyActorName } from "@/lib/ecofy/queries";
import { createCalcDraft, EcofyCallError, listCalcReleases } from "@/lib/ecofy/service";

export const dynamic = "force-dynamic";

function ecofyStatus(err: unknown): number {
    return err instanceof EcofyCallError ? (err.status >= 400 && err.status < 600 ? err.status : 502) : 500;
}

const DraftInput = z.object({ changeNote: z.string().trim().min(3).max(500) });

export const GET = withErrorHandler(async () => {
    await requireRole([...ECOFY_MANAGER_ROLES]);
    try {
        const data = await listCalcReleases();
        return successResponse(Array.isArray(data) ? data : []);
    } catch (err) {
        return errorResponse(err instanceof Error ? err.message : "Could not load calculator releases from Ecofy", ecofyStatus(err));
    }
});

export const POST = withErrorHandler(async (req: Request) => {
    const user = await requireRole([...ECOFY_MANAGER_ROLES]);
    const parsed = DraftInput.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return errorResponse("A change note (at least 3 characters) is required for a new draft", 400);
    try {
        return successResponse(await createCalcDraft(parsed.data.changeNote, ecofyActorName(user)), 201);
    } catch (err) {
        return errorResponse(err instanceof Error ? err.message : "Ecofy could not create the draft", ecofyStatus(err));
    }
});
