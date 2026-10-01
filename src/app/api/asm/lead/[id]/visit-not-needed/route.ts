// POST /api/asm/lead/[id]/visit-not-needed  { reason }
//
// Tracker ID 77 (handover P2-5): Awaiting field visit (Transferred_to_ASM)
// ends only with a visit done or "Visit not needed" with a reason. This is the
// second: the open scheduled / pending visit is cancelled with the reason and
// the lead moves on exactly as a done visit would (applyVisitStatus — the
// pre-transfer stage is restored when further along).

import { z } from "zod";
import { sql } from "drizzle-orm";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { assertOwner } from "@/lib/leads/ownership";
import { withLeadActor } from "@/lib/leads/actorContext";
import { applyVisitStatus } from "@/lib/asm/visitStatus";

const BodySchema = z.object({ reason: z.string().trim().min(5).max(1000) });

export const POST = withErrorHandler(
    async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
        const user = await requireRole(["asm", "admin"]);
        const { id } = await ctx.params;
        if (!id) return errorResponse("Lead id required", 400);
        const { reason } = BodySchema.parse(await req.json());
        await assertOwner(id, user.id);

        const result = await withLeadActor(user.id, async (tx) => {
            const rows = (await tx.execute<{ lead_status: string | null }>(sql`
                SELECT lead_status FROM dealer_leads WHERE id = ${id} LIMIT 1 FOR UPDATE
            `)) as unknown as Array<{ lead_status: string | null }>;
            if (rows[0]?.lead_status !== "Transferred_to_ASM") return null;
            await tx.execute(sql`
                UPDATE lead_visits
                   SET visit_status = 'cancelled',
                       visit_remarks = ${`Visit not needed — ${reason}`},
                       updated_at = NOW()
                 WHERE dealer_lead_id = ${id}
                   AND visit_status IN ('pending_scheduling', 'scheduled')
            `);
            return applyVisitStatus(tx, {
                leadId: id,
                actorId: user.id,
                requested: null,
                remarks: `Visit not needed — ${reason}`,
                // ID 77.4: the reason lands on the status-history row, and a
                // skipped visit is not work — it must not reset the idle clock.
                reasonNotes: `Visit not needed: ${reason}`,
                countsAsWork: false,
            });
        });

        if (!result) return errorResponse("Only a lead awaiting a field visit can be marked 'Visit not needed'.", 409);
        return successResponse({ status: result.status });
    },
);
