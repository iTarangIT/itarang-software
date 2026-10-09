/**
 * POST /api/dealer-accounts/order-claims/[claimId] — tracker ID 5 (E-334).
 *
 * { action: "withdraw", reason } — the order did not happen (or was recorded
 * twice). The claim stops pausing the dealer's ageing and leaves the
 * "Order claimed, no invoice raised" list.
 */
import { z } from "zod";

import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { withdrawOrderClaim } from "@/lib/accounts/orderClaims";
import { MY_DEALERS_ROLES } from "../../_roles";

export const dynamic = "force-dynamic";

const Body = z.object({
    action: z.literal("withdraw"),
    reason: z.string().trim().min(3, "Give a reason.").max(500),
});

export const POST = withErrorHandler(async (req: Request, ctx: { params: Promise<{ claimId: string }> }) => {
    const user = await requireRole(MY_DEALERS_ROLES);
    const claimId = Number((await ctx.params).claimId);
    if (!Number.isInteger(claimId) || claimId <= 0) {
        throw Object.assign(new Error("Order claim not found"), { status: 404 });
    }
    const body = Body.parse(await req.json());
    await withdrawOrderClaim(user, claimId, body.reason);
    return successResponse({ claim_id: claimId, withdrawn: true });
});
