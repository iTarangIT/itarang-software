// E-307 — Sales Head records an eligibility decision from the Eligibility
// queue. The queue lists every Ecofy case iTarang Admin may decide, including
// cases that were never pushed to the CRM, so this is keyed by Ecofy's
// eligibility id rather than a CRM lead.
import { z } from "zod";
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { ECOFY_MANAGER_ROLES } from "@/lib/ecofy/access";
import { notifyEcofyAction } from "@/lib/ecofy/notify";
import { crmLeadIdsForCases, ecofyActorName } from "@/lib/ecofy/queries";
import { decideEligibility, refreshLeadFromEcofy } from "@/lib/ecofy/service";

export const dynamic = "force-dynamic";

const schema = z
    .object({
        caseId: z.string().min(1),
        status: z.enum(["ELIGIBLE", "NOT_ELIGIBLE", "INFO_NEEDED"]),
        maxEligibleInr: z.number().positive().optional(),
        reason: z.string().trim().max(2000).optional(),
    })
    .refine((v) => v.status !== "ELIGIBLE" || Boolean(v.maxEligibleInr), {
        message: "Eligible needs the maximum amount",
        path: ["maxEligibleInr"],
    })
    .refine((v) => v.status === "ELIGIBLE" || (v.reason ?? "").length >= 3, {
        message: "Give a reason or note",
        path: ["reason"],
    });

export const POST = withErrorHandler(async (req: Request, ctx: { params: Promise<{ eligibilityId: string }> }) => {
    const user = await requireRole([...ECOFY_MANAGER_ROLES]);
    const { eligibilityId } = await ctx.params;
    const body = schema.parse(await req.json());

    const result = await decideEligibility(
        eligibilityId,
        {
            status: body.status,
            maxEligibleInr: body.status === "ELIGIBLE" ? body.maxEligibleInr : undefined,
            reason: body.status !== "ELIGIBLE" ? body.reason : undefined,
        },
        ecofyActorName(user),
    );

    const leadId = (await crmLeadIdsForCases([body.caseId])).get(body.caseId);
    if (leadId) {
        const moved = await refreshLeadFromEcofy({ id: leadId, ecofy_case_id: body.caseId });
        await notifyEcofyAction({
            leadId,
            input: {
                action: "eligibility_decision",
                eligibilityId,
                status: body.status,
                maxEligibleInr: body.maxEligibleInr,
                reason: body.reason,
            },
            actor: { id: user.id, name: user.name, role: user.role },
            fromStage: moved.fromStage,
            toStage: moved.toStage,
        });
    }
    return successResponse({ result });
});
