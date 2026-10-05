// POST /api/admin/accounts/move-leaver — every account one person owns, moved
// to another in one step (ID 65). Used when someone leaves; the previous owner
// need not be active, the new one must be.

import { z } from "zod";
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { ACCOUNT_MANAGE_ROLES } from "@/lib/accounts/access";
import { moveLeaverAccounts } from "@/lib/accounts/ownership";

const Body = z.object({
    from_owner_id: z.string().uuid(),
    to_owner_id: z.string().uuid(),
    reason: z.string().max(500),
    effective_date: z.string().nullable().optional(),
});

export const POST = withErrorHandler(async (req: Request) => {
    const user = await requireRole([...ACCOUNT_MANAGE_ROLES]);
    const body = Body.parse(await req.json());
    const result = await moveLeaverAccounts({
        fromOwnerId: body.from_owner_id,
        toOwnerId: body.to_owner_id,
        reason: body.reason,
        effectiveDate: body.effective_date,
        changedBy: user.id,
    });
    return successResponse(result);
});
