/**
 * GET /api/dealer-accounts/[id]/orders — 25 Nov item 8: the dealer page's
 * "Orders & revenue" card — recorded orders still waiting for an invoice, and
 * the invoices with their line items (src/lib/accounts/accountOrders.ts).
 * Same access as the account page (E-358; an ASM reads any account, item 9).
 */
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { ACCOUNT_QUOTE_VIEW_ROLES } from "@/lib/accounts/quotationAccess";
import { assertAccountQuoteAccess } from "@/lib/accounts/quotations/access";
import { accountOrders } from "@/lib/accounts/accountOrders";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const user = await requireRole([...ACCOUNT_QUOTE_VIEW_ROLES]);
    const { id } = await ctx.params;
    await assertAccountQuoteAccess(user, id, "page");
    return successResponse(await accountOrders(id));
});
