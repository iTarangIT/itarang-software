/**
 * E-322 (tracker ID 73) — GET / PUT the standard warranty and delivery terms
 * printed on every quotation. Reps cannot change them on a quote; Admin and
 * CEO set them here. Stored in app_settings['quotation_standard_terms'].
 *
 * GET is open to the roles that raise quotes, so the quote form can show the
 * terms the quote will carry.
 */
import { z } from "zod";

import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { getStandardQuoteTerms, setStandardQuoteTerms } from "@/lib/leads/quoteTerms";

export const dynamic = "force-dynamic";

const VIEWER_ROLES = ["admin", "ceo", "sales_head", "inside_sales_rep", "asm", "partner"];
const EDITOR_ROLES = ["admin", "ceo"];

const BodySchema = z.object({
    warranty: z.string().trim().min(3, "Warranty terms are required.").max(500),
    delivery: z.string().trim().min(3, "Delivery terms are required.").max(500),
});

export const GET = withErrorHandler(async () => {
    const user = await requireRole(VIEWER_ROLES);
    const settings = await getStandardQuoteTerms();
    return successResponse({ settings, can_edit: EDITOR_ROLES.includes(user.role) });
});

export const PUT = withErrorHandler(async (req: Request) => {
    const user = await requireRole(EDITOR_ROLES);
    const body = BodySchema.parse(await req.json());
    const settings = await setStandardQuoteTerms(body, user.id);
    return successResponse({ settings, can_edit: true });
});
