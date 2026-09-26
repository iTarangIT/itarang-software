// POST /api/inside-sales/lead/[id]/whatsapp-onboarding
// Outbound kickoff for WhatsApp dealer onboarding. The inbound webhook flow
// (lib/whatsapp/orchestrator.ts) only starts when the dealer messages first;
// this lets a rep PROACTIVELY invite a just-converted lead onto WhatsApp. It
// links a whatsapp_onboarding_sessions row to the lead's draft onboarding
// application (created by mark-converted) and sends the dealer an invite so
// their first reply continues straight into the onboarding state machine.
//
// E-214: the session-linking + invite logic lives in
// lib/whatsapp/operator-handoff.ts, shared with the operator console's
// "Invite Dealer" action. The lead-side lookup lives in
// lib/leads/onboardingInvite.ts, shared with the WhatsApp Assistant.

import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { prepareOnboardingInvite, sendOnboardingInvite } from "@/lib/leads/onboardingInvite";

const MUTATE_ROLES = ["inside_sales_rep", "asm", "admin", "partner"];

export const POST = withErrorHandler(
    async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
        await requireRole(MUTATE_ROLES);
        const { id } = await ctx.params;
        if (!id) return errorResponse("Lead id required", 400);

        const prep = await prepareOnboardingInvite(id);
        if (!prep.ok) {
            if (prep.reason === "not_found") return errorResponse("Lead not found", 404);
            if (prep.reason === "no_application") {
                return errorResponse("No onboarding application — mark the lead Converted first.", 400);
            }
            return errorResponse("Lead has no valid phone number for WhatsApp.", 400);
        }

        const res = await sendOnboardingInvite(prep.target);

        return successResponse({
            sessionId: res.sessionId,
            delivered: res.ok,
            error: res.ok ? null : (res.error ?? "WhatsApp send failed"),
        });
    },
);
