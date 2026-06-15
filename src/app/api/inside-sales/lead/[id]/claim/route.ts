// POST /api/inside-sales/lead/[id]/claim
// BRD §0.3 Path B — IS rep claims a lead from the New_Unassigned queue.
// Sets current_owner_id + originator_id (if NULL) + lead_status → Assigned_Not_Contacted.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { writeTouchpoint } from "@/lib/touchpoints/write";
import type { LeadStatus } from "@/lib/lifecycle/transitions";

const MUTATE_ROLES = ["inside_sales_rep", "admin"];

export const POST = withErrorHandler(
    async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
        const user = await requireRole(MUTATE_ROLES);
        const { id } = await ctx.params;
        if (!id) return errorResponse("Lead id required", 400);

        const rows = await db.execute<{
            lead_status: string | null;
            originator_id: string | null;
            current_owner_id: string | null;
        }>(sql`
            SELECT lead_status, originator_id, current_owner_id
            FROM dealer_leads WHERE id = ${id} LIMIT 1
        `);
        const row = rows[0];
        if (!row) return errorResponse("Lead not found", 404);
        if (row.current_owner_id) {
            return errorResponse(
                "Lead has already been claimed by another rep.",
                409,
            );
        }
        // Claimable = unowned and not terminal. NULL / legacy-status manual
        // leads are lifted into the pipeline on claim, same as New_Unassigned.
        if (row.lead_status === "Converted" || row.lead_status === "Lost") {
            return errorResponse(
                `Lead is no longer claimable (status=${row.lead_status}).`,
                409,
            );
        }

        await db.execute(sql`
            UPDATE dealer_leads
            SET current_owner_id = ${user.id},
                originator_id = COALESCE(originator_id, ${user.id}),
                assigned_at = NOW(),
                lead_status = 'Assigned_Not_Contacted',
                updated_at = NOW()
            WHERE id = ${id}
        `);

        await writeTouchpoint({
            dealerLeadId: id,
            touchpointType: "lead_claimed",
            performedBy: user.id,
            remarks: "Claimed from unassigned queue",
            statusChange: {
                from: (row.lead_status as LeadStatus | null) ?? "New_Unassigned",
                to: "Assigned_Not_Contacted",
            },
        });

        return successResponse({ ok: true });
    },
);
