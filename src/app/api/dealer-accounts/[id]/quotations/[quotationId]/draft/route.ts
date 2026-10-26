/**
 * POST /api/dealer-accounts/[id]/quotations/[quotationId]/draft — E-358:
 * (re)generate an approved account quotation's document. `{ force: true }`
 * re-renders keeping the same number.
 */
import { z } from "zod";
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { ACCOUNT_QUOTE_VIEW_ROLES } from "@/lib/accounts/quotationAccess";
import { AccountQuoteError, assertAccountQuoteAccess } from "@/lib/accounts/quotations/access";
import { generateAccountQuotationDraft } from "@/lib/accounts/quotations/draft";
import { loadAccountQuotation } from "@/lib/accounts/quotations/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.object({ force: z.boolean().optional() });

export const POST = withErrorHandler(async (req: Request, ctx: { params: { id: string; quotationId: string } }) => {
    const user = await requireRole([...ACCOUNT_QUOTE_VIEW_ROLES]);
    await assertAccountQuoteAccess(user, ctx.params.id, "create");
    const body = Body.parse(await req.json().catch(() => ({})));
    const row = await loadAccountQuotation(ctx.params.id, ctx.params.quotationId);
    if (!row) throw new AccountQuoteError("Quotation not found.", 404);
    if (row.approval_status !== "approved") {
        throw new AccountQuoteError(`This quotation is ${row.approval_status}; a document is made only after approval.`);
    }
    return successResponse(await generateAccountQuotationDraft(row.quotation_id, { force: body.force }));
});
