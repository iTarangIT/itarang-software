// GET /api/inside-sales/lead/[id]/ai-call-profile
// What the AI dialer says and dials for this lead: the spoken shop name
// (computed by spokenName.ts, or a rep's override — E-378) and the numbers a
// call learned (owner mobile / alternate — E-379).
//
// PUT { spokenName: string | null }                   — set the override; blank clears it.
// PUT { contactId: string, status: "active" | "wrong" } — retire / restore a captured number.
// Same read rule as the lead detail bundle (/api/inside-sales/lead/[id]).

import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { dealerLeads } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { readsOwnLeadsOnly } from "@/lib/leads/access";
import { leadVisibleTo } from "@/lib/users/team";
import { setSpokenNameOverride, spokenNameView, SPOKEN_NAME_MAX } from "@/lib/ai-dialer/spokenNameStore";
import { contactsForLead, setContactStatus } from "@/lib/ai-dialer/contactStore";

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
const WRITE_ROLES = ["inside_sales_rep", "asm", "admin", "ceo", "sales_manager", "sales_head", "business_head"];

async function loadLead(id: string) {
    const [lead] = await db
        .select({ id: dealerLeads.id, shop_name: dealerLeads.shop_name })
        .from(dealerLeads)
        .where(eq(dealerLeads.id, id))
        .limit(1);
    return lead ?? null;
}

async function profile(lead: { id: string; shop_name: string | null }) {
    const [spokenName, contacts] = await Promise.all([spokenNameView(lead), contactsForLead(lead.id)]);
    return {
        spokenName,
        contacts: contacts.map((c) => ({
            id: c.id,
            kind: c.kind,
            phone: c.phone,
            name: c.name,
            status: c.status,
            capturedAt: c.capturedAt.toISOString(),
        })),
    };
}

export const GET = withErrorHandler(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const user = await requireRole(READ_ROLES);
    const { id } = await ctx.params;
    if (!id) return errorResponse("Lead id required", 400);
    if (readsOwnLeadsOnly(user.role) && !(await leadVisibleTo(id, user.id))) {
        return errorResponse("Lead not found", 404);
    }
    const lead = await loadLead(id);
    if (!lead) return errorResponse("Lead not found", 404);
    return successResponse(await profile(lead));
});

const PutBody = z.union([
    z.object({ spokenName: z.string().max(SPOKEN_NAME_MAX).nullable() }),
    z.object({ contactId: z.string().min(1), status: z.enum(["active", "wrong"]) }),
]);

export const PUT = withErrorHandler(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const user = await requireRole(WRITE_ROLES);
    const { id } = await ctx.params;
    if (!id) return errorResponse("Lead id required", 400);
    if (readsOwnLeadsOnly(user.role) && !(await leadVisibleTo(id, user.id))) {
        return errorResponse("Lead not found", 404);
    }
    const parsed = PutBody.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return errorResponse(`Spoken name is at most ${SPOKEN_NAME_MAX} characters`, 400);
    const lead = await loadLead(id);
    if (!lead) return errorResponse("Lead not found", 404);
    if ("contactId" in parsed.data) {
        const done = await setContactStatus(id, parsed.data.contactId, parsed.data.status);
        if (!done) return errorResponse("Number not found on this lead", 404);
        return successResponse(await profile(lead));
    }
    const saved = await setSpokenNameOverride(id, parsed.data.spokenName, user.id);
    if (!saved) return errorResponse("Saving a spoken name needs migration E-378", 503);
    return successResponse(await profile(lead));
});
