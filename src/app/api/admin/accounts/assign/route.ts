/**
 * POST /api/admin/accounts/assign — set the owner of one or many accounts.
 *
 * Body: { account_ids: string[], owner_user_id: uuid | null,
 *         effective_from?: 'YYYY-MM-DD', reason: string }
 *
 * owner_user_id null = deliberately unowned. The owner must be an active
 * user with a sales role. History windows + audit rows are written by
 * assignOwner; the onboarding record is never touched.
 */
import { z } from "zod";

import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { assignOwner } from "@/lib/accounts/ownership";
import {
    ACCOUNT_ADMIN_ROLES,
    assertAssignableOwner,
    daySchema,
    requireAccountTables,
    uuidSchema,
} from "../_lib";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
    account_ids: z.array(z.string().trim().min(1).max(255)).min(1, "Pick at least one account").max(1000),
    owner_user_id: uuidSchema.nullable(),
    effective_from: daySchema.optional().nullable(),
    reason: z.string().trim().min(1, "A reason is required").max(1000),
});

export const POST = withErrorHandler(async (req: Request) => {
    const user = await requireRole(ACCOUNT_ADMIN_ROLES);
    await requireAccountTables();
    const body = BodySchema.parse(await req.json());

    if (body.owner_user_id) await assertAssignableOwner(body.owner_user_id);

    const result = await assignOwner(body.account_ids, body.owner_user_id, {
        effectiveFrom: body.effective_from ?? undefined,
        reason: body.reason,
        actorId: user.id,
    });
    return successResponse(result);
});
