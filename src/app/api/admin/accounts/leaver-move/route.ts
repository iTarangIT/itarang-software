/**
 * POST /api/admin/accounts/leaver-move — move every account currently owned
 * by one user to another (or to unowned) from a date. Used when a
 * salesperson leaves.
 *
 * Body: { from_user_id: uuid, to_user_id: uuid | null,
 *         effective_from?: 'YYYY-MM-DD', reason: string }
 */
import { z } from "zod";

import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { bulkMoveOwner } from "@/lib/accounts/ownership";
import {
    ACCOUNT_ADMIN_ROLES,
    assertAssignableOwner,
    daySchema,
    requireAccountTables,
    uuidSchema,
} from "../_lib";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
    from_user_id: uuidSchema,
    to_user_id: uuidSchema.nullable(),
    effective_from: daySchema.optional().nullable(),
    reason: z.string().trim().min(1, "A reason is required").max(1000),
});

export const POST = withErrorHandler(async (req: Request) => {
    const user = await requireRole(ACCOUNT_ADMIN_ROLES);
    await requireAccountTables();
    const body = BodySchema.parse(await req.json());

    // The leaver may already be inactive — only the receiver is validated.
    if (body.to_user_id) await assertAssignableOwner(body.to_user_id);

    const result = await bulkMoveOwner(body.from_user_id, body.to_user_id, {
        effectiveFrom: body.effective_from ?? undefined,
        reason: body.reason,
        actorId: user.id,
    });
    return successResponse(result);
});
