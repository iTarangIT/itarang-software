// POST /api/inside-sales/lead/[id]/mark-lost
// BRD §0.7 — terminal Lost with mandatory reason. High-impact reasons require
// confirmed_high_impact=true (client shows the consequence modal first). The
// write lives in markLeadLost(), shared with the WhatsApp Assistant.

import { z } from "zod";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { LOST_REASON } from "@/lib/lifecycle/transitions";
import { assertOwner } from "@/lib/leads/ownership";
import { canMarkUnownedLeadLost } from "@/lib/leads/access";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";
import {
    CompetitorRequiredError,
    HighImpactUnconfirmedError,
    LostLeadNotFoundError,
    LostNotesRequiredError,
    markLeadLost,
    TestLeadRoleError,
} from "@/lib/leads/markLost";

// ID 252 (decided 12 Nov): the Sales Head works the leads HE OWNS like an ASM;
// the owner check below still applies, so anyone else's lead stays view-only.
// ID 233: CEO only for a lead with no owner (below).
const MUTATE_ROLES = ["inside_sales_rep", "asm", "admin", "partner", "sales_head", "ceo"];

const BodySchema = z.object({
    lost_reason: z.enum(LOST_REASON),
    lost_reason_notes: z.string().max(5000).nullable().optional(),
    confirmed_high_impact: z.boolean().optional(),
    competitor_name: z.string().trim().max(200).nullable().optional(),
});

export const POST = withErrorHandler(
    async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
        const user = await requireRole(MUTATE_ROLES);
        const { id } = await ctx.params;
        if (!id) return errorResponse("Lead id required", 400);
        const body = BodySchema.parse(await req.json());

        // ID 233: Admin, Sales Head and CEO may close a lead that has NO owner
        // (test rows, broken imports); any owned lead stays its owner's to close.
        const ownerRows = (await db.execute<{ current_owner_id: string | null }>(sql`
            SELECT current_owner_id FROM dealer_leads WHERE id = ${id} LIMIT 1
        `)) as unknown as { current_owner_id: string | null }[];
        if (ownerRows.length === 0) return errorResponse("Lead not found", 404);
        const unownedByManager = !ownerRows[0].current_owner_id && canMarkUnownedLeadLost(user.role);
        if (!unownedByManager) await assertOwner(id, user.id);

        try {
            await markLeadLost({
                leadId: id,
                actor: { id: user.id, role: user.role },
                reason: body.lost_reason,
                notes: body.lost_reason_notes ?? null,
                confirmedHighImpact: body.confirmed_high_impact,
                competitorName: body.competitor_name ?? null,
            });
        } catch (err) {
            if (
                err instanceof LostNotesRequiredError ||
                err instanceof HighImpactUnconfirmedError ||
                err instanceof CompetitorRequiredError
            ) {
                return errorResponse(err.message, 400);
            }
            if (err instanceof LostLeadNotFoundError) return errorResponse("Lead not found", 404);
            if (err instanceof TestLeadRoleError) return errorResponse(err.message, 403);
            throw err;
        }

        return successResponse({ ok: true });
    },
);
