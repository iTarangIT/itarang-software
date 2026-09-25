// E-307 — Sales Head assigns / reassigns Ecofy leads to an ASM or ISR.
import { z } from "zod";
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { ECOFY_MANAGER_ROLES } from "@/lib/ecofy/access";
import { assignEcofyLeads } from "@/lib/ecofy/assignment";

export const dynamic = "force-dynamic";

const schema = z.object({
    leadIds: z.array(z.string().uuid()).min(1).max(200),
    targetUserId: z.string().uuid(),
    reason: z.string().trim().max(500).optional(),
});

export const POST = withErrorHandler(async (req: Request) => {
    const user = await requireRole([...ECOFY_MANAGER_ROLES]);
    const body = schema.parse(await req.json());
    const result = await assignEcofyLeads({
        leadIds: [...new Set(body.leadIds)],
        targetUserId: body.targetUserId,
        reason: body.reason || null,
        actor: { id: user.id, name: user.name, role: user.role },
    });
    return successResponse(result);
});
