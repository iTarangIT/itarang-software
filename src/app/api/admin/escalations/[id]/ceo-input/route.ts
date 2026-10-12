// POST /api/admin/escalations/[id]/ceo-input — BRD §0.6 CEO advisory.
// The CEO can Add a Comment and/or Recommend an action on a pending
// escalation. CEO advises; admin executes (§0.12) — this route only writes
// the advisory fields + an audit touchpoint, never `lead_status` or ownership.

import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import { notifyRoles } from "@/lib/notifications/notify";
import { notifyLeadPerson } from "@/lib/leads/newOwnerNotice";
import {
    errorResponse,
    successResponse,
    withErrorHandler,
} from "@/lib/api-utils";
import { writeTouchpoint } from "@/lib/touchpoints/write";

const MUTATE_ROLES = ["ceo"];

const BodySchema = z.discriminatedUnion("action", [
    z.object({
        action: z.literal("comment"),
        text: z.string().trim().min(5).max(5000),
    }),
    z.object({
        action: z.literal("recommend"),
        recommendation: z.enum(["reassign", "return", "no_action"]),
        text: z.string().trim().min(5).max(5000),
    }),
]);

const RECO_LABEL: Record<string, string> = {
    reassign: "Recommend Reassign",
    return: "Recommend Return with guidance",
    no_action: "Recommend No Action",
};

export const POST = withErrorHandler(
    async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
        const user = await requireRole(MUTATE_ROLES);
        const { id } = await ctx.params;
        if (!id) return errorResponse("Escalation id required.", 400);
        const body = BodySchema.parse(await req.json());

        const escRows = await db.execute<{
            dealer_lead_id: string;
            status: string;
            raised_by: string | null;
        }>(sql`
            SELECT dealer_lead_id, status, raised_by FROM lead_escalations
            WHERE escalation_id = ${id} LIMIT 1
        `);
        const esc = escRows[0];
        if (!esc) return errorResponse("Escalation not found.", 404);
        if (esc.status !== "pending_review") {
            return errorResponse(
                "This escalation is already resolved — advisory is closed.",
                409,
            );
        }

        if (body.action === "comment") {
            await db.execute(sql`
                UPDATE lead_escalations
                SET ceo_comment = ${body.text}, updated_at = NOW()
                WHERE escalation_id = ${id}
            `);
            await writeTouchpoint({
                dealerLeadId: esc.dealer_lead_id,
                touchpointType: "escalation_ceo_comment",
                performedBy: user.id,
                remarks: body.text,
            });
        } else {
            const composed = `${RECO_LABEL[body.recommendation]} — ${body.text}`;
            await db.execute(sql`
                UPDATE lead_escalations SET
                    ceo_recommendation = ${composed},
                    ceo_recommended_at = NOW(),
                    updated_at = NOW()
                WHERE escalation_id = ${id}
            `);
            await writeTouchpoint({
                dealerLeadId: esc.dealer_lead_id,
                touchpointType: "escalation_ceo_recommendation",
                performedBy: user.id,
                remarks: composed,
            });
        }

        // 12 Oct: the CEO advises, Sales Head / Admin / Partner execute — they
        // are told (bell opens Escalations); the raiser sees it on the lead.
        const said = body.action === "comment" ? body.text : `${RECO_LABEL[body.recommendation]} — ${body.text}`;
        try {
            await notifyRoles(["admin", "sales_head", "partner"], {
                type: "escalation.ceo_input",
                title: body.action === "comment" ? "CEO commented on an escalation" : "CEO recommended an action on an escalation",
                message: `${user.name ?? "The CEO"}: ${said}`,
                leadId: esc.dealer_lead_id,
                data: { href: "/admin/escalations", escalation_id: id },
            });
        } catch (err) {
            console.error("[ceo-input] notification failed:", err);
        }
        await notifyLeadPerson({
            userId: esc.raised_by,
            actorId: user.id,
            leadId: esc.dealer_lead_id,
            type: "escalation.ceo_input",
            title: "CEO responded to your escalation",
            message: `{by} on {lead}: ${said}`,
        });

        return successResponse({ ok: true, action: body.action });
    },
);
