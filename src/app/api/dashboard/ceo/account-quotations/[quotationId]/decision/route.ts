/**
 * POST /api/dashboard/ceo/account-quotations/[quotationId]/decision — E-358:
 * { decision: "approve" | "reject", reason } on a pending ACCOUNT quotation.
 * Reason required on reject. Approve generates the document and tells the
 * account owner it is ready to send; reject restores the previous approved
 * version and tells the owner why.
 */
import { z } from "zod";
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { decideAccountQuotation } from "@/lib/accounts/quotations/decision";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z
    .object({
        decision: z.enum(["approve", "reject"]),
        reason: z.string().trim().min(1).max(2000).optional(),
    })
    .refine((b) => b.decision !== "reject" || !!b.reason, {
        message: "A rejection reason is required.",
        path: ["reason"],
    });

export const POST = withErrorHandler(async (req: Request, ctx: { params: { quotationId: string } }) => {
    const user = await requireRole(["ceo", "admin"]);
    const body = Body.parse(await req.json());
    return successResponse(
        await decideAccountQuotation({
            quotationId: ctx.params.quotationId,
            decision: body.decision,
            reason: body.reason ?? null,
            actor: { id: user.id, name: user.name },
        }),
    );
});
