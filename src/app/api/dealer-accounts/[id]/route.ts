/**
 * GET /api/dealer-accounts/[id] — E-358: the account page in My Dealers. The
 * account's header and whether the signed-in user may raise its quotations.
 * Only someone in the account's quotation scope (or Admin) reaches it.
 */
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { ACCOUNT_QUOTE_VIEW_ROLES } from "@/lib/accounts/quotationAccess";
import { assertAccountQuoteAccess } from "@/lib/accounts/quotations/access";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async (_req: Request, ctx: { params: { id: string } }) => {
    const user = await requireRole([...ACCOUNT_QUOTE_VIEW_ROLES]);
    const access = await assertAccountQuoteAccess(user, ctx.params.id, "view");
    return successResponse({ account: access.account, can_create: access.canCreate });
});
