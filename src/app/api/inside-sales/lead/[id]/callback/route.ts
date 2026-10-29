// GET /api/inside-sales/lead/[id]/callback
// The lead's open AI-dialer callback (E-356 lead_callbacks), or null — the
// "Callback requested" card on the lead page. Same read rule as the lead
// detail bundle (/api/inside-sales/lead/[id]).

import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { readsOwnLeadsOnly } from "@/lib/leads/access";
import { leadVisibleTo } from "@/lib/users/team";
import { openCallbackForLead } from "@/lib/ai/storage/callOutcomeStore";

export const dynamic = "force-dynamic";

const READ_ROLES = [
    "inside_sales_rep",
    "asm",
    "admin",
    "ceo",
    "sales_manager",
    "sales_head",
    "business_head",
    "partner",
];

export const GET = withErrorHandler(
    async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
        const user = await requireRole(READ_ROLES);
        const { id } = await ctx.params;
        if (!id) return errorResponse("Lead id required", 400);
        if (readsOwnLeadsOnly(user.role) && !(await leadVisibleTo(id, user.id))) {
            return errorResponse("Lead not found", 404);
        }
        return successResponse({ callback: await openCallbackForLead(id) });
    },
);

// POST /api/inside-sales/lead/[id]/callback  { action: "resolve_complaint", note? }
// D8 — a complaint stays open (and the lead out of AI calling) until the
// person handling it marks it resolved. The lead's owner, or a manager.
const RESOLVE_ROLES = ["inside_sales_rep", "asm", "admin", "ceo", "sales_manager", "sales_head", "business_head"];

export const POST = withErrorHandler(
    async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
        const user = await requireRole(RESOLVE_ROLES);
        const { id } = await ctx.params;
        if (!id) return errorResponse("Lead id required", 400);
        if (readsOwnLeadsOnly(user.role) && !(await leadVisibleTo(id, user.id))) {
            return errorResponse("Lead not found", 404);
        }
        const body = (await req.json().catch(() => ({}))) as { action?: string; note?: string };
        if (body.action !== "resolve_complaint") return errorResponse("Unknown action", 400);
        const { resolveComplaint } = await import("@/lib/ai-dialer/callbackLoop");
        const done = await resolveComplaint(id, user.id, String(body.note ?? "").slice(0, 500));
        if (!done) return errorResponse("No open complaint on this lead", 404);
        return successResponse({ resolved: true });
    },
);
