// POST /api/admin/accounts/assign — assign or reassign one account or many
// (ID 65). Always with a reason and an effective date; every change is one row
// in account_ownership_history. The onboarding record is never edited.

import { z } from "zod";
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { ACCOUNT_MANAGE_ROLES } from "@/lib/accounts/access";
import { ACCOUNT_BULK_CAP, assignAccountOwner } from "@/lib/accounts/accountOwner";

const Body = z.object({
    account_ids: z.array(z.string().min(1)).min(1).max(ACCOUNT_BULK_CAP),
    owner_id: z.string().uuid(),
    reason: z.string().max(500),
    effective_date: z.string().nullable().optional(),
});

export const POST = withErrorHandler(async (req: Request) => {
    const user = await requireRole([...ACCOUNT_MANAGE_ROLES]);
    const body = Body.parse(await req.json());
    const result = await assignAccountOwner({
        accountIds: body.account_ids,
        toOwnerId: body.owner_id,
        reason: body.reason,
        effectiveDate: body.effective_date,
        changedBy: user.id,
    });
    return successResponse(result);
});
