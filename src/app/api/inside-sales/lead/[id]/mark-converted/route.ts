// POST /api/inside-sales/lead/[id]/mark-converted
// BRD §0.7 — terminal Converted, settable from any status: the funnel-order and
// final_price gates are gone (a deal can close on the first call, and a lead
// closed by mistake has to be recoverable). On success it also creates the draft
// dealer_onboarding_applications row (BRD §0.13 Point A).

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { auditLogs } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { writeTouchpoint } from "@/lib/touchpoints/write";
import { type LeadStatus } from "@/lib/lifecycle/transitions";
import { assertOwner } from "@/lib/leads/ownership";
import { createOnboardingApplicationForConvertedLead } from "@/lib/onboarding/fromConvertedLead";
import { notifyRoles, notifyUser } from "@/lib/notifications/notify";

const MUTATE_ROLES = ["inside_sales_rep", "asm", "admin"];

// BRD §0.13 closing_role audit — derived from actor role + lead history. An
// Inside Sales rep closing a lead that passed through an ASM (asm_id set, then
// reassigned back) is a post-handoff close; a direct phone close otherwise.
function deriveClosingRole(
    role: string,
    asmId: string | null,
): "is_phone" | "asm_visit" | "is_post_handoff" | "admin" {
    if (role === "asm") return "asm_visit";
    if (role === "admin") return "admin";
    return asmId ? "is_post_handoff" : "is_phone";
}

const BodySchema = z.object({
    notes: z.string().max(5000).nullable().optional(),
});

export const POST = withErrorHandler(
    async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
        const user = await requireRole(MUTATE_ROLES);
        const { id } = await ctx.params;
        if (!id) return errorResponse("Lead id required", 400);
        const body = BodySchema.parse(await req.json());

        await assertOwner(id, user.id);

        const rows = await db.execute<{
            lead_status: string | null;
            asm_id: string | null;
        }>(sql`
            SELECT dl.lead_status, dl.asm_id
            FROM dealer_leads dl WHERE dl.id = ${id} LIMIT 1
        `);
        const state = rows[0];
        if (!state) return errorResponse("Lead not found", 404);
        // Reachable from ANY status, a closed one and none at all included.
        // Re-converting is safe: the onboarding application is created ON
        // CONFLICT DO NOTHING, keyed on the lead.
        const fromStatus = state.lead_status as LeadStatus | null;

        const closingRole = deriveClosingRole(user.role, state.asm_id);
        const remarks =
            body.notes?.trim() ||
            "Lead marked as Converted. Dealer onboarding initiated.";

        // BRD §0.13 Point A — conversion and onboarding creation commit or roll
        // back together. If the onboarding application can't be created, the
        // status change is undone, so a lead is never left Converted without an
        // application. writeTouchpoint + the onboarding creator both run on the
        // same `tx`.
        const onboardingApplicationId = await db.transaction(async (tx) => {
            await writeTouchpoint(
                {
                    dealerLeadId: id,
                    touchpointType: "status_change_note",
                    performedBy: user.id,
                    remarks,
                    statusChange: {
                        from: fromStatus,
                        to: "Converted",
                        reasonNotes: body.notes ?? null,
                        closingRole,
                    },
                },
                { tx },
            );

            const { applicationId } =
                await createOnboardingApplicationForConvertedLead(id, tx);
            if (!applicationId) {
                throw new Error("Failed to create dealer onboarding application");
            }

            // BRD §0.13 audit — record the onboarding initiation event.
            await tx.insert(auditLogs).values({
                id: randomUUID(),
                entity_type: "dealer_lead",
                entity_id: id,
                action: "onboarding_initiated",
                performed_by: user.id,
                new_data: { onboarding_application_id: applicationId },
                timestamp: new Date(),
            });

            return applicationId;
        });

        // BRD §0.13 Step 7 — notify the closing owner + admins. Best-effort:
        // the conversion already committed, so a notification failure must not
        // fail the request.
        try {
            await notifyUser(user.id, {
                type: "onboarding_initiated",
                title: "Dealer onboarding initiated",
                message:
                    "Lead converted — a draft dealer onboarding application was created.",
                leadId: id,
                data: { onboarding_application_id: onboardingApplicationId },
            });
            await notifyRoles(["admin", "sales_head"], {
                type: "onboarding_initiated",
                title: "New dealer onboarding application created",
                message: `${user.name} converted a lead — onboarding application created.`,
                leadId: id,
                data: { onboarding_application_id: onboardingApplicationId },
            });
        } catch (err) {
            console.error("[mark-converted] notification failed:", err);
        }

        return successResponse({ ok: true, onboardingApplicationId });
    },
);
