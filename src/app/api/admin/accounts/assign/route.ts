<<<<<<< HEAD
// POST /api/admin/accounts/assign — assign or reassign one account or many
// (ID 65). Always with a reason and an effective date; every change is one row
// in account_ownership_history. The onboarding record is never edited.

import { z } from "zod";
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { ACCOUNT_MANAGE_ROLES } from "@/lib/accounts/access";
import { ACCOUNT_BULK_CAP, assignAccountOwner } from "@/lib/accounts/ownership";

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
=======
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
>>>>>>> fac2a80905456e04c4d89ee14f26fdf80ae34f9e
    });
    return successResponse(result);
});
