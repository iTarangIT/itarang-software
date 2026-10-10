// POST /api/inside-sales/lead/[id]/gstin   { gstin, reason }
//
// Tracker ID 124: Correct GSTIN for a Won lead — updates the lead and its
// onboarding application together, logged with who and why. The lead's owner,
// the Sales Head or admin (checked against the locked row in
// correctLeadGstin.ts). A Converted dealer's GSTIN is corrected on the account.

import { z } from "zod";
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { correctLeadGstin } from "@/lib/leads/correctLeadGstin";

const ROLES = ["inside_sales_rep", "asm", "partner", "sales_head", "admin"];

const BodySchema = z.object({
    gstin: z.string().trim().min(1).max(20),
    reason: z.string().trim().min(5).max(1000),
});

export const POST = withErrorHandler(
    async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
        const user = await requireRole(ROLES);
        const { id } = await ctx.params;
        const body = BodySchema.parse(await req.json());

        // Throws LeadGstinCorrectionError (400 / 403 / 404 / 409) before anything is written.
        const result = await correctLeadGstin({
            leadId: id,
            actor: { id: user.id, role: user.role },
            gstin: body.gstin,
            reason: body.reason,
        });
        return successResponse(result);
    },
);
