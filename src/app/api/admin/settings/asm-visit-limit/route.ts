/**
 * Tracker ID 77.1 — GET / PUT the "Awaiting field visit" limit: working days
 * from Transfer to ASM to the first visit before the lead is flagged overdue.
 * Stored in app_settings['asm_transfer_visit_limit_days'].
 */
import { z } from "zod";

import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import {
    ASM_TRANSFER_VISIT_LIMIT_MAX,
    getAsmTransferVisitLimit,
    setAsmTransferVisitLimit,
} from "@/lib/asm/transferVisitLimit";

export const dynamic = "force-dynamic";

const VIEWER_ROLES = ["admin", "ceo", "sales_head"];
const EDITOR_ROLES = ["admin", "sales_head"];

const BodySchema = z.object({
    days: z.number().int().min(1).max(ASM_TRANSFER_VISIT_LIMIT_MAX),
});

export const GET = withErrorHandler(async () => {
    const user = await requireRole(VIEWER_ROLES);
    const settings = await getAsmTransferVisitLimit();
    return successResponse({
        settings,
        max: ASM_TRANSFER_VISIT_LIMIT_MAX,
        can_edit: EDITOR_ROLES.includes(user.role),
    });
});

export const PUT = withErrorHandler(async (req: Request) => {
    const user = await requireRole(EDITOR_ROLES);
    const { days } = BodySchema.parse(await req.json());
    const settings = await setAsmTransferVisitLimit(days, user.id);
    return successResponse({ settings, max: ASM_TRANSFER_VISIT_LIMIT_MAX, can_edit: true });
});
