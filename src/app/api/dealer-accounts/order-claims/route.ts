/**
 * GET /api/dealer-accounts/order-claims?status=unconfirmed|pending|open|confirmed|withdrawn|all
 * — tracker ID 5 (E-334). Default `unconfirmed`: "Order claimed, no invoice
 * raised", the exception list for sales and finance. Managers and finance see
 * every account; an owner sees their own. `mine=1` narrows anyone to their own.
 */
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { listOrderClaims } from "@/lib/accounts/orderClaims";
import { hasOrderClaimTables } from "@/lib/accounts/tables";
import { ORDER_CLAIM_API_ROLES, seesEveryClaim } from "../_roles";

export const dynamic = "force-dynamic";

const STATUSES = ["unconfirmed", "pending", "open", "confirmed", "withdrawn", "all"] as const;
type Status = (typeof STATUSES)[number];

export const GET = withErrorHandler(async (req: Request) => {
    const user = await requireRole(ORDER_CLAIM_API_ROLES);
    const params = new URL(req.url).searchParams;
    const raw = params.get("status") ?? "unconfirmed";
    const mine = params.get("mine") === "1";
    const status: Status = (STATUSES as readonly string[]).includes(raw) ? (raw as Status) : "unconfirmed";
    const rows = await listOrderClaims({
        status: status === "all" ? undefined : status,
        ownerId: mine || !seesEveryClaim(user.role) ? user.id : undefined,
    });
    return successResponse({ rows, status, available: await hasOrderClaimTables() });
});
