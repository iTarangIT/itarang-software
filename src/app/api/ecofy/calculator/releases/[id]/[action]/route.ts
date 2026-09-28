// Calculator designer (Ecofy M08, CONFLICTS #31) — release lifecycle and test bench.
//
// POST /api/ecofy/calculator/releases/:id/submit   { note? }        DRAFT → PENDING_APPROVAL
// POST /api/ecofy/calculator/releases/:id/approve  { note? }        PENDING_APPROVAL → PUBLISHED (previous → RETIRED)
// POST /api/ecofy/calculator/releases/:id/reject   { note }         PENDING_APPROVAL → DRAFT
// POST /api/ecofy/calculator/releases/:id/restore  { changeNote }   any release → a new DRAFT copy
// POST /api/ecofy/calculator/releases/:id/test     CalcInput        every step against THIS release (never stored)
import { z } from "zod";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { ECOFY_MANAGER_ROLES } from "@/lib/ecofy/access";
import { ecofyActorName } from "@/lib/ecofy/queries";
import { decideCalcRelease, EcofyCallError, runCalcTestBench, type EcofyCalcDecision } from "@/lib/ecofy/service";

export const dynamic = "force-dynamic";

function ecofyStatus(err: unknown): number {
    return err instanceof EcofyCallError ? (err.status >= 400 && err.status < 600 ? err.status : 502) : 500;
}

const DECISIONS: EcofyCalcDecision[] = ["submit", "approve", "reject", "restore"];

const NoteInput = z.object({ note: z.string().trim().max(1000).optional() });
const RestoreInput = z.object({ changeNote: z.string().trim().min(3).max(500) });

// Mirrors Ecofy's CalcInput (m07-assessment/schemas.ts), same as /api/ecofy/calculator.
const TestInput = z.object({
    segment: z.enum(["RESI", "ESS", "CI"]),
    productInterest: z.enum(["SOLAR_STORAGE", "STORAGE_ONLY", "SOLAR_ONLY", "NOT_SURE"]).optional(),
    method: z.enum(["APPLIANCES", "MONTHLY_UNITS", "RUNNING_LOAD", "NONE"]),
    appliances: z
        .array(z.object({ applianceName: z.string().min(1), watts: z.number().int().min(1), quantity: z.number().int().min(1) }))
        .max(100)
        .optional(),
    monthlyUnits: z.number().min(0).optional(),
    runningLoadKw: z.number().min(0).optional(),
    sanctionedLoadKw: z.number().min(0).optional(),
    backupHours: z.number().min(0).max(24).optional(),
    phase: z.enum(["SINGLE", "THREE"]),
});

export const POST = withErrorHandler(async (req: Request, ctx: { params: Promise<{ id: string; action: string }> }) => {
    const user = await requireRole([...ECOFY_MANAGER_ROLES]);
    const { id, action } = await ctx.params;
    const body = await req.json().catch(() => null);

    if (action === "test") {
        const parsed = TestInput.safeParse(body);
        if (!parsed.success) {
            const first = parsed.error.issues[0];
            return errorResponse(`Invalid calculator input${first ? `: ${first.path.join(".")} ${first.message}` : ""}`, 400);
        }
        try {
            return successResponse(await runCalcTestBench(id, parsed.data));
        } catch (err) {
            return errorResponse(err instanceof Error ? err.message : "Ecofy could not run the test bench", ecofyStatus(err));
        }
    }

    if (!DECISIONS.includes(action as EcofyCalcDecision)) return errorResponse("Unknown action", 404);
    const decision = action as EcofyCalcDecision;

    let note: string | undefined;
    if (decision === "restore") {
        const parsed = RestoreInput.safeParse(body);
        if (!parsed.success) return errorResponse("A change note (at least 3 characters) is required to restore a release", 400);
        note = parsed.data.changeNote;
    } else {
        const parsed = NoteInput.safeParse(body ?? {});
        if (!parsed.success) return errorResponse("Invalid note", 400);
        note = parsed.data.note;
        if (decision === "reject" && !note) return errorResponse("A rejection note is required", 400);
    }

    try {
        return successResponse(await decideCalcRelease(id, decision, note, ecofyActorName(user)));
    } catch (err) {
        return errorResponse(err instanceof Error ? err.message : `Ecofy refused to ${decision} the release`, ecofyStatus(err));
    }
});
