/**
 * ID 204 — POST { phone, kinds?, sms?, smsDay? }: send the EMI messages to a
 * test phone with sample values — WhatsApp (the pending text when there is
 * one) and the SMS plan's templates (4 Nov).
 * A person's send, not a job: it goes out from any site.
 */
import { z } from "zod";
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { sendEmiTestMessages } from "@/lib/emi-messages/run";
import { EMI_MESSAGE_KINDS } from "@/lib/emi-messages/rules";

export const dynamic = "force-dynamic";

const Body = z.object({
    phone: z.string().trim().min(10).max(16),
    kinds: z.array(z.enum(EMI_MESSAGE_KINDS)).optional(),
    /** 4 Nov: also the SMS plan (reminder of `smsDay`, आज, overdue, received). */
    sms: z.boolean().optional(),
    whatsapp: z.boolean().optional(),
    smsDay: z.number().int().min(1).max(31).optional(),
});

export const POST = withErrorHandler(async (req: Request) => {
    await requireRole(["admin", "sales_head"]);
    const body = Body.parse(await req.json());
    return successResponse({ results: await sendEmiTestMessages(body) });
});
