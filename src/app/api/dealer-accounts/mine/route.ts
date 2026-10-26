/**
 * GET /api/dealer-accounts/mine — tracker ID 5, "My dealers": the dealer
 * accounts the signed-in user owns, with their health bucket (Dealer Health's
 * rows, filtered to the owner) and any open "Order placed" claim.
 *
 * E-356 (24 Oct meeting): an ASM also sees their direct reports' accounts, and
 * Sales Head / CEO / Partner see every account — the same scope as account
 * quotations (src/lib/accounts/quotationAccess.ts). Each row says whose it is
 * (`scope`: own / team / other) so the page can filter.
 */
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { listDealerHealth } from "@/lib/dealers/accountHealth";
import { hasOrderClaimTables } from "@/lib/accounts/tables";
import { myDealersScope } from "@/lib/accounts/quotationAccess";
import { getTeamMemberIds } from "@/lib/users/team";
import { MY_DEALERS_ROLES } from "../_roles";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async () => {
    const user = await requireRole(MY_DEALERS_ROLES);
    const scope = myDealersScope(user.role);
    const team = new Set(scope === "team" ? await getTeamMemberIds(user.id) : []);
    const whose = (ownerId: string | null) =>
        ownerId === user.id ? "own" : ownerId && team.has(ownerId) ? "team" : "other";
    const rows = (await listDealerHealth())
        .filter((r) => r.account_id)
        .map((r) => ({ ...r, scope: whose(r.owner_id) }))
        .filter((r) => r.scope === "own" || (scope === "team" && r.scope === "team") || scope === "all");
    return successResponse({ rows, scope, can_record_orders: await hasOrderClaimTables() });
});
