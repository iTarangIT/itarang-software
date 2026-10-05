/**
 * E-322 (tracker ID 71) — POST /api/dashboard/ceo/invoices/[id]/void
 *
 *   { source: 'zoho' | 'drive' | 'credit', action: 'void' | 'restore', reason }
 *
 * Finance marks an invoice void (reason required, logged); a voided invoice
 * stops counting in revenue everywhere. 'restore' undoes a mistaken void (also
 * logged). See src/lib/sales/invoiceVoids.ts.
 */
import { z } from "zod";

import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { hasInvoiceLedgerTables } from "@/lib/sales/ledgerTables";
import { InvoiceVoidError, VOIDABLE_SOURCES, unvoidInvoice, voidInvoice } from "@/lib/sales/invoiceVoids";

export const dynamic = "force-dynamic";

const ROLES = ["finance_controller", "ceo", "admin"];

const BodySchema = z.object({
    source: z.enum(VOIDABLE_SOURCES),
    action: z.enum(["void", "restore"]),
    reason: z.string().trim().min(3, "Give a reason.").max(500),
});

export const POST = withErrorHandler(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const user = await requireRole(ROLES);
    if (!(await hasInvoiceLedgerTables())) {
        throw new InvoiceVoidError("Invoice voids need migration E-322 on this database.", 503);
    }
    const { id } = await ctx.params;
    const body = BodySchema.parse(await req.json());
    const result =
        body.action === "void"
            ? await voidInvoice({ source: body.source, invoiceId: id, reason: body.reason, origin: "manual", actorId: user.id })
            : await unvoidInvoice({ source: body.source, invoiceId: id, reason: body.reason, actorId: user.id });
    return successResponse(result);
});
