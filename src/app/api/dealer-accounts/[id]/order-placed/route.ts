/**
 * POST /api/dealer-accounts/[id]/order-placed — tracker ID 5 (E-334).
 *
 * { order_date: "YYYY-MM-DD", po_number?, note? } — the dealer's owner (or a
 * sales manager) records an order before its invoice exists. The dealer's
 * ageing counts from the order date for 15 days; an invoice in that window
 * confirms it (src/lib/accounts/orderClaims.ts).
 */
import { z } from "zod";

import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { recordOrderClaim } from "@/lib/accounts/orderClaims";
import { MY_DEALERS_ROLES } from "../../_roles";

export const dynamic = "force-dynamic";

const Body = z.object({
    order_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick the order date."),
    po_number: z.string().trim().max(100).optional().nullable(),
    note: z.string().trim().max(500).optional().nullable(),
});

export const POST = withErrorHandler(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const user = await requireRole(MY_DEALERS_ROLES);
    const { id } = await ctx.params;
    const body = Body.parse(await req.json());
    const claim = await recordOrderClaim(user, id, {
        orderDate: body.order_date,
        poNumber: body.po_number,
        note: body.note,
    });
    return successResponse({ claim_id: claim.id, account_id: id });
});
