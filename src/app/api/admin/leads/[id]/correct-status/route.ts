// POST /api/admin/leads/[id]/correct-status
//   { to, reason, lost_reason?, competitor_name? }
//
// Tracker ID 80 / 115 (handover P2-8, P0-11): every status change has an event
// behind it, and admin "Correct status" is the ONLY override — to any status
// except Won and Converted, with a required reason, logged in the status history and on the
// lead timeline. Goes through writeTouchpoint with the "correction" event, so
// the terminal bookkeeping (closed_at / closing owner) stays consistent. A
// correction is not work on the lead: it does NOT reset the idle clock
// (isWorkedTouchpoint) — a neglected lead must not look fresh because an admin
// fixed its status.
//
// ID 57: the override does not skip what Mark Lost enforces. To Lost it needs a
// lost reason (and the competitor for "Lost to competition") (planCorrection).
//
// ID 133 (3 Oct): Won and Converted are refused. Until then a correction to
// Converted made a live dealer with no documents, verification, agreement or
// approval — and left an empty draft application that later fell into
// drop-out review. Converted comes only from onboarding approval; Won from
// Mark Won.

import { z } from "zod";
import { sql } from "drizzle-orm";
import { requireRole } from "@/lib/auth-utils";
import { STATUS_CORRECTION_ROLES } from "@/lib/leads/access";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { LEAD_STATUS, LOST_REASON, type LeadStatus } from "@/lib/lifecycle/transitions";
import { withLeadActor } from "@/lib/leads/actorContext";
import { planCorrection } from "@/lib/leads/correctStatus";
import { writeTouchpoint } from "@/lib/touchpoints/write";

const BodySchema = z.object({
    to: z.enum(LEAD_STATUS),
    reason: z.string().trim().min(5).max(2000),
    lost_reason: z.enum(LOST_REASON).nullable().optional(),
    competitor_name: z.string().trim().max(200).nullable().optional(),
});

export const POST = withErrorHandler(
    async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
        // Admin and Sales Head (ID 80 locked it to admin on 26 Sep; the Sales
        // Head was added on 6 Oct 2026 at the business's request) — not the CEO.
        const user = await requireRole([...STATUS_CORRECTION_ROLES]);
        const { id } = await ctx.params;
        const body = BodySchema.parse(await req.json());
        const { to, reason } = body;

        const [lead] = (await db.execute<{ lead_status: string | null }>(sql`
            SELECT lead_status FROM dealer_leads WHERE id = ${id} LIMIT 1
        `)) as unknown as Array<{ lead_status: string | null }>;
        if (!lead) return errorResponse("Lead not found", 404);

        // Throws CorrectionInputError (400) before anything is written — Won
        // and Converted among them (ID 133).
        const plan = planCorrection({
            to,
            lostReason: body.lost_reason,
            competitorName: body.competitor_name,
        });

        const result = await withLeadActor(user.id, async (tx) => {
            // The two things Mark Lost records besides the reason (markLost.ts):
            // the competitor's name (ID 76), and business_closed permanently
            // excluding the lead from the AI dialer (BRD §0.7).
            if (plan.competitorName) {
                await tx.execute(sql`
                    UPDATE dealer_leads SET competitor_name = ${plan.competitorName} WHERE id = ${id}
                `);
            }
            if (plan.toLostReason === "business_closed") {
                await tx.execute(sql`
                    UPDATE dealer_leads SET ai_recall_status = 'excluded', updated_at = NOW() WHERE id = ${id}
                `);
            }

            const written = await writeTouchpoint(
                {
                    dealerLeadId: id,
                    touchpointType: "status_change_note",
                    performedBy: user.id,
                    remarks: `Status corrected by ${user.role === "sales_head" ? "Sales Head" : "admin"} — ${reason}`,
                    // ID 115.5: a correction is not the owner working
                    // the lead — it must not reset the idle clock.
                    countsAsWork: false,
                    statusChange: {
                        from: lead.lead_status as LeadStatus | null,
                        to,
                        toLostReason: plan.toLostReason,
                        reasonNotes: `Correct status: ${reason}`,
                        closingRole: "admin",
                        event: "correction",
                    },
                },
                { tx },
            );

            return written;
        });
        return successResponse(result);
    },
);
