// mark_lost — close a lead as Lost with one of its reasons (BRD §9.2). PROPOSES
// only: the preview shows "from → Lost" with the consequence; markLostApplier
// writes through markLeadLost() (the mark-lost route's own writer) from the
// executor, in its transaction. `other` needs notes; the four high-impact
// reasons need a second Confirm on a warning preview (step 2 only).
//
// onboarding_dropout is not offered: the screen's Mark Lost modal refuses it
// for everyone but admin (BRD §0.11), and admin is not an Assistant role.

import { z } from "zod";
import { LOST_REASON, isHighImpactLostReason, type LostReason } from "@/lib/lifecycle/transitions";
import { markLeadLost } from "@/lib/leads/markLost";
import { createPending } from "../../actions";
import { reasonLabel, statusLabel } from "../../format";
import type { Preview, ToolResult } from "../../types";
import { defineTool, LeadId, ownedLeadOr, type ToolFactory } from "../spec";
import { leadUrl } from "../leads";
import { defineApplier } from "../../applierSpec";
import { highImpactConsequence, highImpactWarning } from "./logCall";
import { Remarks } from "./vocabSchemas";

/** The reasons a rep may pick on the screen — every LOST_REASON but the admin-only one. */
export const REP_LOST_REASONS = LOST_REASON.filter((r) => r !== "onboarding_dropout") as Exclude<
    LostReason,
    "onboarding_dropout"
>[];

export const MarkLostPlan = z.object({
    lead_id: z.string().min(1),
    reason: z.enum(REP_LOST_REASONS as [LostReason, ...LostReason[]]),
    notes: z.string().nullable(),
});
export type MarkLostPlan = z.infer<typeof MarkLostPlan>;

const ask = (question: string): ToolResult => ({ kind: "question", question });

export const markLost: ToolFactory = () =>
    defineTool({
        name: "mark_lost",
        kind: "write",
        description:
            "Propose closing a lead the user owns as Lost, with a lost reason (notes required for 'other'). " +
            "High-impact reasons need a second confirmation. Nothing is saved until Confirm.",
        schema: z.object({
            lead_id: LeadId,
            lost_reason: z.enum(REP_LOST_REASONS as [LostReason, ...LostReason[]]),
            notes: Remarks.optional(),
        }),
        run: async (ctx, input): Promise<ToolResult> => {
            const owned = await ownedLeadOr(ctx, input.lead_id);
            if (owned.result) return owned.result;
            const lead = owned.lead;
            const crmUrl = leadUrl(ctx.user, lead.id);

            if (lead.lead_status === "Lost") return { kind: "declined", reason: "This lead is already Lost.", crm_url: crmUrl };
            // The screen allows Lost from Converted for the onboarding-dropout
            // loopback. That undoes a conversion, so it stays on the screen.
            if (lead.lead_status === "Converted") {
                return {
                    kind: "declined",
                    reason: "This lead is Converted. Closing a converted lead is done on the CRM screen.",
                    crm_url: crmUrl,
                };
            }
            const notes = input.notes?.trim() || null;
            if (input.lost_reason === "other" && !notes) return ask("Why was it lost? I need a short note for 'other'.");

            const plan: MarkLostPlan = { lead_id: lead.id, reason: input.lost_reason, notes };
            const lines: Preview["lines"] = [
                { label: "Status", value: `${statusLabel(lead.lead_status)} → Lost (${reasonLabel(plan.reason)})` },
            ];
            if (notes) lines.push({ label: "Notes", value: notes });
            const secondConfirm = isHighImpactLostReason(plan.reason);
            const preview: Preview = {
                title: `Mark Lost — ${lead.shop_name || lead.dealer_name || lead.id}`,
                lines,
                // A status change is work (isWorkedTouchpoint).
                resets_idle_clock: true,
                warning: secondConfirm ? highImpactConsequence(plan.reason) : null,
                needs_second_confirm: secondConfirm,
                crm_url: crmUrl,
            };
            const { id } = await createPending({
                userId: ctx.user.id,
                tool: "mark_lost",
                leadId: lead.id,
                leadVersion: lead.updated_at,
                plan,
                preview,
                before: { lead_status: lead.lead_status },
                sourceMessageId: ctx.messageId,
            });
            return { kind: "preview", action_id: id, preview };
        },
    });

export const markLostApplier = defineApplier<MarkLostPlan>({
    schema: MarkLostPlan,
    needsSecondConfirm: (p) => isHighImpactLostReason(p.reason),
    secondConfirmWarning: (p) => highImpactWarning(p.reason),
    apply: async ({ tx, user, step }, p) => {
        await markLeadLost(
            {
                leadId: p.lead_id,
                actor: { id: user.id, role: user.role },
                reason: p.reason,
                notes: p.notes,
                // Only a step-2 action carries the second Confirm.
                confirmedHighImpact: step === 2,
            },
            { tx },
        );
        return {};
    },
});
