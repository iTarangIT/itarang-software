// GET /api/admin/accounts/[id]/history — who has owned this account, when and
// why (ID 65).

import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { ACCOUNT_MANAGE_ROLES } from "@/lib/accounts/access";
import { gstinCorrection, listOwnershipHistory } from "@/lib/accounts/ownership";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async (_req: Request, context: { params: Promise<{ id: string }> }) => {
    await requireRole([...ACCOUNT_MANAGE_ROLES]);
    const { id } = await context.params;
    const accountId = decodeURIComponent(id);
    const [history, gstin_corrected] = await Promise.all([listOwnershipHistory(accountId), gstinCorrection(accountId)]);
    return successResponse({ history, gstin_corrected });
});
