/**
 * E-356 — an account's quotations (24 Oct meeting, items 8–11).
 *
 *   GET   every version on the account, newest first.
 *   POST  raise a new version { product_lines, terms, notes? }. Auto-approved
 *         when every line is at or above its OEM reference price on cash
 *         terms; otherwise it waits for the CEO.
 *
 * Scope (src/lib/accounts/quotationAccess.ts): the owner (ISR / ASM), the
 * owner's ASM, or Sales Head / CEO / Partner. Admin reads, never creates.
 */
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { ACCOUNT_QUOTE_VIEW_ROLES } from "@/lib/accounts/quotationAccess";
import { assertAccountQuoteAccess } from "@/lib/accounts/quotations/access";
import { createAccountQuotation, CreateAccountQuoteSchema } from "@/lib/accounts/quotations/create";
import { listAccountQuotations } from "@/lib/accounts/quotations/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = withErrorHandler(async (_req: Request, ctx: { params: { id: string } }) => {
    const user = await requireRole([...ACCOUNT_QUOTE_VIEW_ROLES]);
    const access = await assertAccountQuoteAccess(user, ctx.params.id, "view");
    return successResponse({
        account: access.account,
        can_create: access.canCreate,
        quotations: await listAccountQuotations(ctx.params.id),
    });
});

export const POST = withErrorHandler(async (req: Request, ctx: { params: { id: string } }) => {
    const user = await requireRole([...ACCOUNT_QUOTE_VIEW_ROLES]);
    const { account } = await assertAccountQuoteAccess(user, ctx.params.id, "create");
    const body = CreateAccountQuoteSchema.parse(await req.json());
    const result = await createAccountQuotation({ account, actor: { id: user.id, name: user.name }, body });
    const { quote_number } = await result.afterCommit();
    return successResponse(
        {
            quotation_id: result.quotationId,
            version_no: result.versionNo,
            approval_status: result.approvalStatus,
            auto_approved: result.autoApproved,
            terms_hold: result.termsHold,
            quote_number,
        },
        201,
    );
});
