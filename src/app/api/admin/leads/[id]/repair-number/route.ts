// POST /api/admin/leads/[id]/repair-number  { action?, new_phone?, note }
// Number Repair (tracker ID 36): fix a dead / non-responsive lead's number (or
// confirm it) and put the lead back into the working queues. The lead's owner
// of record, a manager or an admin may do it.
//
//   action 'repair' (default)  new_phone set → deduped, then the flag is lifted.
//                              new_phone blank → confirm; a dead_number flag
//                              stays (note only), non_responsive is lifted.
//   action 'mark_lost'         "Repair failed → Lost": closes the lead through
//                              the Mark Lost writer, reason 'other'.

import { NextResponse } from "next/server";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import {
    closeLeadAfterFailedRepair,
    DuplicateRepairPhoneError,
    InvalidRepairPhoneError,
    repairLeadNumber,
} from "@/lib/leads/contactability";
import { LostLeadNotFoundError } from "@/lib/leads/markLost";
import { StatusGuardError } from "@/lib/touchpoints/write";

const MANAGERS = ["admin", "ceo", "sales_head", "sales_manager", "business_head"];
const REPS = ["inside_sales_rep", "asm", "partner"];

const BodySchema = z.discriminatedUnion("action", [
    z.object({
        action: z.literal("repair"),
        new_phone: z.string().trim().regex(/^\d{10}$/, "Phone must be exactly 10 digits").nullable().optional(),
        note: z.string().trim().min(3).max(500),
    }),
    z.object({
        action: z.literal("mark_lost"),
        note: z.string().trim().max(500).nullable().optional(),
    }),
]);

export const POST = withErrorHandler(
    async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
        const user = await requireRole([...MANAGERS, ...REPS]);
        const { id } = await ctx.params;
        const raw = (await req.json()) as Record<string, unknown>;
        const body = BodySchema.parse({ ...raw, action: raw?.action ?? "repair" });

        const [lead] = (await db.execute<{ current_owner_id: string | null; lead_status: string | null }>(sql`
            SELECT current_owner_id, lead_status FROM dealer_leads WHERE id = ${id} LIMIT 1
        `)) as unknown as Array<{ current_owner_id: string | null; lead_status: string | null }>;
        if (!lead) return errorResponse("Lead not found", 404);
        if (!MANAGERS.includes(user.role) && lead.current_owner_id !== user.id) {
            return errorResponse("Only the lead owner or a manager can repair its number.", 403);
        }

        if (body.action === "mark_lost") {
            if (lead.lead_status === "Lost") return errorResponse("This lead is already Lost.", 409);
            try {
                await closeLeadAfterFailedRepair({
                    leadId: id,
                    actor: { id: user.id, role: user.role },
                    note: body.note ?? null,
                });
            } catch (err) {
                if (err instanceof LostLeadNotFoundError) return errorResponse("Lead not found", 404);
                if (err instanceof StatusGuardError) return errorResponse(err.message, 409);
                throw err;
            }
            return successResponse({ ok: true, lost: true });
        }

        try {
            const result = await repairLeadNumber({
                leadId: id,
                actorId: user.id,
                newPhone: body.new_phone ?? null,
                note: body.note,
            });
            return successResponse({ ok: true, ...result });
        } catch (err) {
            if (err instanceof InvalidRepairPhoneError) return errorResponse(err.message, 400);
            if (err instanceof DuplicateRepairPhoneError) {
                return NextResponse.json(
                    {
                        success: false,
                        error: { message: err.message, duplicate_lead_id: err.duplicateLeadId },
                        timestamp: new Date().toISOString(),
                    },
                    { status: 409 },
                );
            }
            throw err;
        }
    },
);
