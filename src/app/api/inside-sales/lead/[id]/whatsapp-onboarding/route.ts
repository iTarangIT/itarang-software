// POST /api/inside-sales/lead/[id]/whatsapp-onboarding
// Outbound kickoff for WhatsApp dealer onboarding. The inbound webhook flow
// (lib/whatsapp/orchestrator.ts) only starts when the dealer messages first;
// this lets a rep PROACTIVELY invite a just-converted lead onto WhatsApp. It
// links a whatsapp_onboarding_sessions row to the lead's draft onboarding
// application (created by mark-converted) and sends the dealer an invite so
// their first reply continues straight into the onboarding state machine.
//
// E-214: the session-linking + invite logic now lives in
// lib/whatsapp/operator-handoff.ts, shared with the operator console's
// "Invite Dealer" action, so there is one implementation of "bind a number to an
// application and invite it".

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { dealerLeads } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { inviteDealerToApplication } from "@/lib/whatsapp/operator-handoff";
import { toWaPhone } from "@/lib/whatsapp/operator-identity";

const MUTATE_ROLES = ["inside_sales_rep", "asm", "admin"];

export const POST = withErrorHandler(
    async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
        await requireRole(MUTATE_ROLES);
        const { id } = await ctx.params;
        if (!id) return errorResponse("Lead id required", 400);

        const [lead] = await db
            .select({
                phone: dealerLeads.phone,
                dealer_name: dealerLeads.dealer_name,
                application_id: dealerLeads.dealer_onboarding_application_id,
            })
            .from(dealerLeads)
            .where(sql`${dealerLeads.id} = ${id}`)
            .limit(1);
        if (!lead) return errorResponse("Lead not found", 404);
        if (!lead.application_id) {
            return errorResponse(
                "No onboarding application — mark the lead Converted first.",
                400,
            );
        }

        // dealer_leads.phone is stored as 10 digits; WhatsApp wants E.164 without '+'.
        const waPhone = toWaPhone(lead.phone ?? "");
        if (!waPhone) {
            return errorResponse("Lead has no valid phone number for WhatsApp.", 400);
        }

        const res = await inviteDealerToApplication({
            applicationId: lead.application_id,
            dealerWaPhone: waPhone,
            dealerName: lead.dealer_name,
        });

        return successResponse({
            sessionId: res.sessionId,
            delivered: res.ok,
            error: res.ok ? null : (res.error ?? "WhatsApp send failed"),
        });
    },
);
