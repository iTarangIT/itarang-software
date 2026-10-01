// POST /api/admin/leads/[id]/correct-status  { to, reason }
//
// Tracker ID 80 / 115 (handover P2-8, P0-11): every status change has an event
// behind it, and admin "Correct status" is the ONLY override — any status to
// any status, with a required reason, logged in the status history and on the
// lead timeline. Goes through writeTouchpoint with the "correction" event, so
// the terminal bookkeeping (closed_at / closing owner) stays consistent.

import { z } from "zod";
import { sql } from "drizzle-orm";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { LEAD_STATUS, type LeadStatus } from "@/lib/lifecycle/transitions";
import { withLeadActor } from "@/lib/leads/actorContext";
import { writeTouchpoint } from "@/lib/touchpoints/write";

const BodySchema = z.object({
    to: z.enum(LEAD_STATUS),
    reason: z.string().trim().min(5).max(2000),
});

export const POST = withErrorHandler(
    async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
        const user = await requireRole(["admin", "ceo"]);
        const { id } = await ctx.params;
        const { to, reason } = BodySchema.parse(await req.json());

        const [lead] = (await db.execute<{ lead_status: string | null }>(sql`
            SELECT lead_status FROM dealer_leads WHERE id = ${id} LIMIT 1
        `)) as unknown as Array<{ lead_status: string | null }>;
        if (!lead) return errorResponse("Lead not found", 404);

        const result = await withLeadActor(user.id, (tx) =>
            writeTouchpoint(
                {
                    dealerLeadId: id,
                    touchpointType: "status_change_note",
                    performedBy: user.id,
                    remarks: `Status corrected by admin — ${reason}`,
                    // ID 115.5: an admin's correction is not the owner working
                    // the lead — it must not reset the idle clock.
                    countsAsWork: false,
                    statusChange: {
                        from: lead.lead_status as LeadStatus | null,
                        to,
                        reasonNotes: `Correct status: ${reason}`,
                        closingRole: "admin",
                        event: "correction",
                    },
                },
                { tx },
            ),
        );
        return successResponse(result);
    },
);
