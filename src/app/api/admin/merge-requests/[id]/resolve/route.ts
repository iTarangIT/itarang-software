// POST /api/admin/merge-requests/[id]/resolve — BRD §0.4.
// Address-mismatch requests get the 5 resolution actions; phone-collision
// requests get 3. admin_resolution_notes is mandatory for every action.
// V1 does not auto-merge — the admin records the decision; physical merges
// happen by inspection outside the system.

import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import {
    errorResponse,
    successResponse,
    withErrorHandler,
} from "@/lib/api-utils";
import { writeTouchpoint } from "@/lib/touchpoints/write";
import {
    ADDRESS_MISMATCH_ACTIONS,
    PHONE_COLLISION_ACTIONS,
} from "@/lib/admin/types";

const MUTATE_ROLES = ["admin", "sales_head"];

const BodySchema = z.object({
    resolution_action: z.string().min(1),
    admin_resolution_notes: z.string().trim().min(5).max(5000),
    new_address: z.string().trim().max(500).optional().nullable(),
});

// BRD §0.4 — resolution_action → duplicate_merge_requests.status.
const STATUS_FOR_ACTION: Record<string, string> = {
    same_dealer_relocated: "accepted",
    data_error_reject: "rejected_not_duplicate",
    different_branch_same_owner: "accepted",
    different_dealer_sharing_number: "deferred",
    skip_keep_existing: "deferred",
    accepted_manual: "accepted",
    rejected: "rejected_not_duplicate",
    deferred: "deferred",
};

export const POST = withErrorHandler(
    async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
        const user = await requireRole(MUTATE_ROLES);
        const { id } = await ctx.params;
        if (!id) return errorResponse("Merge request id required.", 400);
        const body = BodySchema.parse(await req.json());

        const reqRows = await db.execute<{
            request_type: string;
            target_lead_id: string;
            status: string;
        }>(sql`
            SELECT request_type, target_lead_id, status
            FROM duplicate_merge_requests WHERE id = ${id} LIMIT 1
        `);
        const mr = reqRows[0];
        if (!mr) return errorResponse("Merge request not found.", 404);
        if (mr.status !== "pending") {
            return errorResponse("This merge request is already resolved.", 409);
        }

        // Validate the action is legal for this request type.
        const isAddress = mr.request_type.startsWith("address_mismatch");
        const allowed: readonly string[] = isAddress
            ? ADDRESS_MISMATCH_ACTIONS
            : PHONE_COLLISION_ACTIONS;
        if (!allowed.includes(body.resolution_action)) {
            return errorResponse(
                `Action "${body.resolution_action}" is not valid for ${mr.request_type}.`,
                400,
            );
        }
        const newStatus = STATUS_FOR_ACTION[body.resolution_action] ?? "deferred";

        // Side effects on the target lead.
        if (body.resolution_action === "same_dealer_relocated") {
            // Append the current address to address_history, then update it.
            const leadRows = await db.execute<{ location: string | null }>(sql`
                SELECT location FROM dealer_leads WHERE id = ${mr.target_lead_id} LIMIT 1
            `);
            const oldAddress = leadRows[0]?.location ?? null;
            const historyEntry = JSON.stringify([
                {
                    address: oldAddress,
                    notes: body.admin_resolution_notes,
                    updated_at: new Date().toISOString(),
                    updated_by: user.id,
                },
            ]);
            await db.execute(sql`
                UPDATE dealer_leads SET
                    address_history = COALESCE(address_history, '[]'::jsonb) || ${historyEntry}::jsonb,
                    location = ${body.new_address ?? sql`location`},
                    updated_at = NOW()
                WHERE id = ${mr.target_lead_id}
            `);
            await writeTouchpoint({
                dealerLeadId: mr.target_lead_id,
                touchpointType: "status_change_note",
                performedBy: user.id,
                remarks: `Address-mismatch resolved — same dealer relocated. ${body.admin_resolution_notes}`,
            });
        } else if (body.resolution_action === "different_branch_same_owner") {
            // V1 keeps the row; admin records a branch note for future tracking.
            await db.execute(sql`
                UPDATE dealer_leads SET
                    address_notes = CONCAT_WS(E'\n',
                        NULLIF(address_notes, ''), ${body.admin_resolution_notes}),
                    updated_at = NOW()
                WHERE id = ${mr.target_lead_id}
            `);
        }

        await db.execute(sql`
            UPDATE duplicate_merge_requests SET
                status = ${newStatus},
                resolution_action = ${body.resolution_action},
                admin_resolution_notes = ${body.admin_resolution_notes},
                resolved_by = ${user.id},
                resolved_at = NOW(),
                updated_at = NOW()
            WHERE id = ${id}
        `);

        return successResponse({ ok: true, status: newStatus });
    },
);
