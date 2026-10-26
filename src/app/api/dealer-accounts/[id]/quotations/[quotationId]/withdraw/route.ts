/**
 * POST /api/dealer-accounts/[id]/quotations/[quotationId]/withdraw — E-356:
 * { reason } — withdraw a version the account has not approved. The previous
 * live version becomes current again.
 */
import { z } from "zod";
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { ACCOUNT_QUOTE_VIEW_ROLES } from "@/lib/accounts/quotationAccess";
import { assertAccountQuoteAccess } from "@/lib/accounts/quotations/access";
import { withdrawAccountQuotation } from "@/lib/accounts/quotations/decision";

export const dynamic = "force-dynamic";

const Body = z.object({ reason: z.string().trim().min(3, "Give a reason.").max(1000) });

export const POST = withErrorHandler(async (req: Request, ctx: { params: { id: string; quotationId: string } }) => {
    const user = await requireRole([...ACCOUNT_QUOTE_VIEW_ROLES]);
    await assertAccountQuoteAccess(user, ctx.params.id, "create");
    const body = Body.parse(await req.json());
    return successResponse(
        await withdrawAccountQuotation({
            accountId: ctx.params.id,
            quotationId: ctx.params.quotationId,
            reason: body.reason,
            actor: { id: user.id },
        }),
    );
});
