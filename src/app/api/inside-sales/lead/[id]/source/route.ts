// PATCH /api/inside-sales/lead/[id]/source
// Tracker ID 81 — record Found via (and the campaign) on a lead that has none.
//
// Source is captured at creation and then locked (E-317). Leads made before
// that have no Found via, and for the rep-created ones nothing in the data
// says what it was — only a person knows. This lets that person say it ONCE:
// an empty value can be filled, a recorded one can never be changed (the
// route refuses, and the database lock would keep the old value anyway).
//
// Who: the lead's owner, or a lead-oversight role.

import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { LEADS_OVERSIGHT_ROLES } from "@/lib/leads/access";
import { resolveLeadCampaign } from "@/lib/leads/acquisitionCampaigns";
import { LEAD_ORIGIN_LABEL, LEAD_ORIGINS } from "@/lib/leads/leadSourceVocab";
import { writeTouchpoint } from "@/lib/touchpoints/write";

const ROLES = [...new Set(["inside_sales_rep", "asm", ...LEADS_OVERSIGHT_ROLES])];

const BodySchema = z.object({
    origin: z.enum(LEAD_ORIGINS, { message: "Pick how the dealer was found (Found via)." }),
    campaign_id: z.string().uuid().optional().nullable(),
});

export const PATCH = withErrorHandler(
    async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
        const user = await requireRole(ROLES);
        const { id } = await ctx.params;
        const body = BodySchema.parse(await req.json());

        const rows = await db.execute<{
            current_owner_id: string | null;
            source_origin: string | null;
            campaign_id: string | null;
        }>(sql`
            SELECT current_owner_id, source_origin, acquisition_campaign_id::text AS campaign_id
              FROM dealer_leads WHERE id = ${id} LIMIT 1
        `);
        const lead = rows[0];
        if (!lead) return errorResponse("Lead not found", 404);

        const oversight = (LEADS_OVERSIGHT_ROLES as readonly string[]).includes(user.role);
        if (!oversight && lead.current_owner_id !== user.id) {
            return errorResponse("Only the lead's owner can record where it came from.", 403);
        }
        if (lead.source_origin) {
            return errorResponse("Found via is already recorded on this lead and cannot be changed.", 409);
        }

        // A campaign already on the lead (its upload batch, its list) stands.
        const campaignId = lead.campaign_id
            ? null
            : await resolveLeadCampaign(db, { origin: body.origin, campaignId: body.campaign_id });

        await db.transaction(async (tx) => {
            await tx.execute(sql`
                UPDATE dealer_leads
                   SET source_origin = COALESCE(source_origin, ${body.origin}),
                       acquisition_campaign_id = COALESCE(acquisition_campaign_id, ${campaignId}::uuid)
                 WHERE id = ${id}
            `);
            await writeTouchpoint(
                {
                    dealerLeadId: id,
                    touchpointType: "status_change_note",
                    performedBy: user.id,
                    remarks: `Found via recorded: ${LEAD_ORIGIN_LABEL[body.origin]} (was not recorded).`,
                },
                { tx },
            );
        });

        return successResponse({ source_origin: body.origin });
    },
);
