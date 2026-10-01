// POST /api/admin/leads/[id]/correct-status
//   { to, reason, lost_reason?, competitor_name?, gstin? }
//
// Tracker ID 80 / 115 (handover P2-8, P0-11): every status change has an event
// behind it, and admin "Correct status" is the ONLY override — any status to
// any status, with a required reason, logged in the status history and on the
// lead timeline. Goes through writeTouchpoint with the "correction" event, so
// the terminal bookkeeping (closed_at / closing owner) stays consistent. A
// correction is not work on the lead: it does NOT reset the idle clock
// (isWorkedTouchpoint) — a neglected lead must not look fresh because an admin
// fixed its status.
//
// ID 57: the override does not skip what Mark Lost / Mark Won enforce. To Lost
// it needs a lost reason (and the competitor for "Lost to competition"); to Won
// or Converted the lead must carry a valid GSTIN — typed here or already on it —
// and gets its onboarding application if it has none (planCorrection).

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { auditLogs } from "@/lib/db/schema";
import { LEAD_STATUS, LOST_REASON, type LeadStatus } from "@/lib/lifecycle/transitions";
import { withLeadActor } from "@/lib/leads/actorContext";
import { planCorrection } from "@/lib/leads/correctStatus";
import { normalizeGstin } from "@/lib/leads/gstin";
import { attachOnboardingToWonLead } from "@/lib/leads/markConverted";
import { writeTouchpoint } from "@/lib/touchpoints/write";

const BodySchema = z.object({
    to: z.enum(LEAD_STATUS),
    reason: z.string().trim().min(5).max(2000),
    lost_reason: z.enum(LOST_REASON).nullable().optional(),
    competitor_name: z.string().trim().max(200).nullable().optional(),
    gstin: z.string().max(40).nullable().optional(),
});

export const POST = withErrorHandler(
    async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
        // Admin only (ID 80, locked 26 Sep) — not the CEO.
        const user = await requireRole(["admin"]);
        const { id } = await ctx.params;
        const body = BodySchema.parse(await req.json());
        const { to, reason } = body;

        const [lead] = (await db.execute<{ lead_status: string | null }>(sql`
            SELECT lead_status FROM dealer_leads WHERE id = ${id} LIMIT 1
        `)) as unknown as Array<{ lead_status: string | null }>;
        if (!lead) return errorResponse("Lead not found", 404);

        // The GSTIN is read only when it decides something, so a correction to
        // any other status runs the same statements it always did.
        let existingGstin: string | null = null;
        if (to === "Won" || to === "Converted") {
            const [row] = (await db.execute<{ gstin: string | null }>(sql`
                SELECT gstin FROM dealer_leads WHERE id = ${id} LIMIT 1
            `)) as unknown as Array<{ gstin: string | null }>;
            existingGstin = row?.gstin ?? null;
        }

        // Throws CorrectionInputError (400) before anything is written.
        const plan = planCorrection({
            to,
            lostReason: body.lost_reason,
            competitorName: body.competitor_name,
            gstin: body.gstin,
            existingGstin,
        });

        const result = await withLeadActor(user.id, async (tx) => {
            if (plan.gstin) {
                await tx.execute(sql`
                    UPDATE dealer_leads SET gstin = ${plan.gstin} WHERE id = ${id}
                `);
            }
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
                    remarks: `Status corrected by admin — ${reason}`,
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

            if (plan.needsOnboarding) {
                const { applicationId, created } = await attachOnboardingToWonLead(
                    tx,
                    id,
                    plan.gstin ?? normalizeGstin(existingGstin),
                );
                if (created) {
                    // BRD §0.13 audit — same row Mark Won writes.
                    await tx.insert(auditLogs).values({
                        id: randomUUID(),
                        entity_type: "dealer_lead",
                        entity_id: id,
                        action: "onboarding_initiated",
                        performed_by: user.id,
                        new_data: { onboarding_application_id: applicationId, via: "correct_status" },
                        timestamp: new Date(),
                    });
                }
            }
            return written;
        });
        return successResponse(result);
    },
);
