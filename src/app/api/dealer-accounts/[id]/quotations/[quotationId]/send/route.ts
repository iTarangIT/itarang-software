/**
 * E-356 — send an approved account quotation to the account.
 *
 *   GET   the recipients the dialog prefills (the account's email / phone)
 *         and every past send attempt.
 *   POST  { channels: ("email"|"whatsapp")[], email?, phone?, message?, cc? }
 *         Refused unless the version is approved, current and has a document.
 */
import { z } from "zod";
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { QUOTE_DISPATCH_CHANNELS } from "@/lib/leads/quoteDispatch";
import { MAX_EXTRA_CC } from "@/lib/leads/quotationCcRules";
import { ACCOUNT_QUOTE_VIEW_ROLES } from "@/lib/accounts/quotationAccess";
import { AccountQuoteError, assertAccountQuoteAccess } from "@/lib/accounts/quotations/access";
import { sendAccountQuotation } from "@/lib/accounts/quotations/send";
import { accountQuoteNotSendable, listAccountDispatches, loadAccountQuotation } from "@/lib/accounts/quotations/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.object({
    channels: z.array(z.enum(QUOTE_DISPATCH_CHANNELS)).min(1, "Pick email, WhatsApp or both."),
    email: z.string().trim().email().max(320).nullable().optional(),
    phone: z.string().trim().max(20).nullable().optional(),
    message: z.string().trim().max(2000).nullable().optional(),
    cc: z.array(z.string().trim().email()).max(MAX_EXTRA_CC).optional(),
});

export const GET = withErrorHandler(async (_req: Request, ctx: { params: { id: string; quotationId: string } }) => {
    const user = await requireRole([...ACCOUNT_QUOTE_VIEW_ROLES]);
    const { account } = await assertAccountQuoteAccess(user, ctx.params.id, "view");
    const row = await loadAccountQuotation(ctx.params.id, ctx.params.quotationId);
    if (!row) throw new AccountQuoteError("Quotation not found.", 404);
    return successResponse({
        quote_number: row.quote_number,
        pdf_url: row.quote_pdf_url,
        email: account.contact_email,
        phone: account.contact_phone,
        not_sendable: accountQuoteNotSendable(row),
        dispatches: await listAccountDispatches(row.quotation_id),
    });
});

export const POST = withErrorHandler(async (req: Request, ctx: { params: { id: string; quotationId: string } }) => {
    const user = await requireRole([...ACCOUNT_QUOTE_VIEW_ROLES]);
    const { account } = await assertAccountQuoteAccess(user, ctx.params.id, "create");
    const body = Body.parse(await req.json());
    return successResponse(
        await sendAccountQuotation({
            account,
            quotationId: ctx.params.quotationId,
            channels: body.channels,
            email: body.email,
            phone: body.phone,
            message: body.message,
            extraCc: body.cc,
            actor: { id: user.id, name: user.name },
        }),
    );
});
