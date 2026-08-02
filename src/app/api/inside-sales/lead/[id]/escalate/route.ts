// POST /api/inside-sales/lead/[id]/escalate
// BRD §0.6 — raise an escalation. Owner remains unchanged; admin resolves
// (Module 3). escalation_status flips to 'pending_review' on dealer_leads.

import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { leadEscalations, dealerLeads } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { writeTouchpoint } from "@/lib/touchpoints/write";
import { assertOwner } from "@/lib/leads/ownership";
import { OPEN_STATUSES, type LeadStatus } from "@/lib/lifecycle/transitions";
import { notifyRoles } from "@/lib/notifications/notify";

const MUTATE_ROLES = ["inside_sales_rep", "asm", "admin"];

// BRD §0.6 reason picker — IS Rep options. ASM options will land in Module 2.
const IS_REP_REASONS = [
    "Commercial_Decision_Needed",
    "Customer_Complaint",
    "Compliance_Concern",
    "Internal_Dispute",
    "Other",
] as const;

const ASM_REASONS = [
    "Not_Ready_for_Visit",
    "Dealer_Stalling",
    "Territory_Mismatch",
    "Customer_Complaint",
    "Internal_Dispute",
    "Compliance_Concern",
    "Other",
] as const;

const ALL_REASONS = [...new Set([...IS_REP_REASONS, ...ASM_REASONS])];

const BodySchema = z.object({
    escalation_reason: z.enum(ALL_REASONS as [string, ...string[]]),
    escalation_notes: z.string().min(30).max(5000),
    suggested_action: z.string().max(1000).nullable().optional(),
    urgency: z.enum(["normal", "high", "urgent"]),
});

export const POST = withErrorHandler(
    async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
        const user = await requireRole(MUTATE_ROLES);
        const { id } = await ctx.params;
        if (!id) return errorResponse("Lead id required", 400);
        const body = BodySchema.parse(await req.json());

        await assertOwner(id, user.id);

        const stateRows = await db.execute<{ lead_status: string | null }>(sql`
            SELECT lead_status FROM ${dealerLeads} WHERE id = ${id} LIMIT 1
        `);
        const status = stateRows[0]?.lead_status as LeadStatus | null;
        if (!status) return errorResponse("Lead not found", 404);
        if (!OPEN_STATUSES.includes(status)) {
            return errorResponse("Escalation requires an open lead status.", 400);
        }

        const inserted = await db
            .insert(leadEscalations)
            .values({
                dealer_lead_id: id,
                raised_by: user.id,
                raised_at: new Date(),
                escalation_reason: body.escalation_reason,
                escalation_notes: body.escalation_notes,
                suggested_action: body.suggested_action ?? null,
                urgency: body.urgency,
                status: "pending_review",
            })
            .returning({ escalation_id: leadEscalations.escalation_id });

        const escalationId = inserted[0]?.escalation_id ?? null;

        await db.execute(sql`
            UPDATE ${dealerLeads}
            SET escalation_status = 'pending_review',
                escalation_count = COALESCE(escalation_count, 0) + 1,
                last_escalation_id = ${escalationId},
                updated_at = NOW()
            WHERE id = ${id}
        `);

        await writeTouchpoint({
            dealerLeadId: id,
            touchpointType: "escalation_raised",
            performedBy: user.id,
            remarks: `[${body.urgency.toUpperCase()}] ${body.escalation_reason}\n\n${body.escalation_notes}${
                body.suggested_action ? `\n\nSuggested: ${body.suggested_action}` : ""
            }`,
        });

        // BRD §0.6 — in-app escalation alerts. Admin + sales_head on every
        // escalation; CEO additionally on Urgent. Wrapped — a notification
        // failure must never break escalation creation.
        try {
            const roles =
                body.urgency === "urgent"
                    ? ["admin", "sales_head", "ceo"]
                    : ["admin", "sales_head"];
            await notifyRoles(roles, {
                type: "escalation_raised",
                title:
                    body.urgency === "urgent"
                        ? "Urgent escalation raised"
                        : "Escalation raised",
                message: `${body.escalation_reason.replace(/_/g, " ")} — raised by ${user.name}`,
                data: { escalation_id: escalationId, lead_id: id },
                leadId: id,
            });
        } catch (err) {
            console.error("[escalate] notification failed:", err);
        }

        return successResponse({ escalation_id: escalationId });
    },
);
