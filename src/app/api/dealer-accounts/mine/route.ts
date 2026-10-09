/**
 * GET /api/dealer-accounts/mine — tracker ID 5, "My dealers": the dealer
 * accounts the signed-in user owns, with their health bucket (Dealer Health's
 * rows, filtered to the owner) and any open "Order placed" claim.
 */
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { listDealerHealth } from "@/lib/dealers/accountHealth";
import { hasOrderClaimTables } from "@/lib/accounts/tables";
import { MY_DEALERS_ROLES } from "../_roles";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async () => {
    const user = await requireRole(MY_DEALERS_ROLES);
    const rows = (await listDealerHealth()).filter((r) => r.account_id && r.owner_id === user.id);
    return successResponse({ rows, can_record_orders: await hasOrderClaimTables() });
});
