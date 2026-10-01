// invite_dealer_onboarding — send a converted lead's dealer the WhatsApp
// onboarding invite: the lead screen's "Invite on WhatsApp" action, through the
// same CRM-side function (lib/leads/onboardingInvite.ts) — the Assistant never
// reaches into the dealer bot itself (INV7). Reached from the "Send invite"
// button after a conversion, or by asking. PROPOSES only: the preview names the
// dealer and the number that will be messaged.
//
// The send is external and cannot roll back, so the applier writes nothing in
// the transaction — the send runs in afterCommit, once the action is recorded,
// and its delivery comes back on the confirmed outcome for the reply.

import { z } from "zod";
import { prepareOnboardingInvite, sendOnboardingInvite } from "@/lib/leads/onboardingInvite";
import { createPending } from "../../actions";
import type { Preview, ToolResult } from "../../types";
import { defineTool, LeadId, NOT_FOUND, ownedLeadOr, type ToolFactory } from "../spec";
import { leadUrl } from "../leads";
import { defineApplier } from "../../applierSpec";

export const InviteDealerPlan = z.object({
    lead_id: z.string().min(1),
    application_id: z.string().min(1),
    wa_phone: z.string().min(10),
    dealer_name: z.string().nullable(),
});
export type InviteDealerPlan = z.infer<typeof InviteDealerPlan>;

export const inviteDealerOnboarding: ToolFactory = () =>
    defineTool({
        name: "invite_dealer_onboarding",
        kind: "write",
        description:
            "Propose sending a CONVERTED lead's dealer the WhatsApp onboarding invite. Only when the user asks for it. " +
            "Nothing is sent until Confirm.",
        schema: z.object({ lead_id: LeadId }),
        run: async (ctx, input): Promise<ToolResult> => {
            const owned = await ownedLeadOr(ctx, input.lead_id);
            if (owned.result) return owned.result;
            const lead = owned.lead;
            const crmUrl = leadUrl(ctx.user, lead.id);

            const prep = await prepareOnboardingInvite(lead.id);
            if (!prep.ok) {
                if (prep.reason === "not_found") return NOT_FOUND;
                return {
                    kind: "declined",
                    reason:
                        prep.reason === "no_application"
                            ? "This lead has no onboarding application yet — mark it Converted first."
                            : "This lead has no valid phone number for WhatsApp.",
                    crm_url: crmUrl,
                };
            }

            const plan: InviteDealerPlan = {
                lead_id: lead.id,
                application_id: prep.target.applicationId,
                wa_phone: prep.target.waPhone,
                dealer_name: prep.target.dealerName,
            };
            const preview: Preview = {
                title: `Onboarding invite — ${lead.shop_name || lead.dealer_name || lead.id}`,
                lines: [
                    { label: "Dealer", value: plan.dealer_name?.trim() || "—" },
                    { label: "WhatsApp", value: `+${plan.wa_phone}` },
                ],
                resets_idle_clock: false,
                warning: "This sends the dealer a WhatsApp message.",
                needs_second_confirm: false,
                crm_url: crmUrl,
            };
            const { id } = await createPending({
                userId: ctx.user.id,
                tool: "invite_dealer_onboarding",
                leadId: lead.id,
                leadVersion: lead.updated_at,
                plan,
                preview,
                before: {},
                sourceMessageId: ctx.messageId,
            });
            return { kind: "preview", action_id: id, preview };
        },
    });

export const inviteDealerOnboardingApplier = defineApplier<InviteDealerPlan>({
    schema: InviteDealerPlan,
    apply: async (_ctx, p) => ({
        afterCommit: async () => {
            const res = await sendOnboardingInvite({
                applicationId: p.application_id,
                waPhone: p.wa_phone,
                dealerName: p.dealer_name,
            });
            return {
                delivered: res.ok,
                session_id: res.sessionId,
                error: res.ok ? null : (res.error ?? "WhatsApp send failed"),
            };
        },
    }),
});
