// escalate_lead — raise an escalation on an open lead the user owns (BRD §0.6).
// The owner does not change; admin resolves it. PROPOSES only: the reasons are
// the ones the Escalate modal offers this role, notes need 30+ characters in the
// user's own words. On Confirm, escalateLeadApplier runs escalateLead() — the
// route's own writer — on the executor's transaction; the admin / sales-head
// (+ CEO when urgent) notifications go out after commit, as on the screen.

import { z } from "zod";
import {
    ASM_ESCALATION_REASONS,
    ESCALATION_NOTES_MIN,
    ESCALATION_URGENCIES,
    IS_REP_ESCALATION_REASONS,
    escalateLead as escalateLeadWrite,
} from "@/lib/leads/escalate";
import { OPEN_STATUSES, type LeadStatus } from "@/lib/lifecycle/transitions";
import { isWorkedTouchpoint } from "@/lib/lifecycle/touchpointTypes";
import { createPending } from "../../actions";
import { reasonLabel, statusLabel } from "../../format";
import type { AssistantRole, Preview, ToolResult } from "../../types";
import { defineTool, LeadId, ownedLeadOr, type ToolFactory } from "../spec";
import { leadUrl } from "../leads";
import { defineApplier } from "../../applierSpec";

export function escalationReasonsFor(role: AssistantRole): readonly string[] {
    return role === "asm" ? ASM_ESCALATION_REASONS : IS_REP_ESCALATION_REASONS;
}

export const EscalateLeadPlan = z.object({
    lead_id: z.string().min(1),
    reason: z.string().min(1),
    notes: z.string().min(ESCALATION_NOTES_MIN),
    urgency: z.enum(ESCALATION_URGENCIES),
    suggested_action: z.string().nullable(),
});
export type EscalateLeadPlan = z.infer<typeof EscalateLeadPlan>;

const ask = (question: string): ToolResult => ({ kind: "question", question });

export const escalateLead: ToolFactory = (role) =>
    defineTool({
        name: "escalate_lead",
        kind: "write",
        description:
            "Propose raising an escalation on an open lead the user owns — for admin to review; the owner does not change. " +
            `Needs a reason, urgency (normal / high / urgent) and notes of at least ${ESCALATION_NOTES_MIN} characters in the ` +
            "user's own words (never pad them). Nothing is saved until Confirm.",
        schema: z.object({
            lead_id: LeadId,
            reason: z.enum(escalationReasonsFor(role) as [string, ...string[]]),
            urgency: z.enum(ESCALATION_URGENCIES),
            notes: z.string().trim().max(5000),
            suggested_action: z.string().trim().max(1000).optional(),
        }),
        run: async (ctx, input): Promise<ToolResult> => {
            const owned = await ownedLeadOr(ctx, input.lead_id);
            if (owned.result) return owned.result;
            const lead = owned.lead;
            const crmUrl = leadUrl(ctx.user, lead.id);

            if (!OPEN_STATUSES.includes(lead.lead_status as LeadStatus)) {
                return {
                    kind: "declined",
                    reason: `Only an open lead can be escalated. This one is ${statusLabel(lead.lead_status)}.`,
                    crm_url: crmUrl,
                };
            }
            const notes = input.notes.trim();
            if (notes.length < ESCALATION_NOTES_MIN) {
                return ask(`What's the issue? I need a note of at least ${ESCALATION_NOTES_MIN} characters for the escalation.`);
            }

            const plan: EscalateLeadPlan = {
                lead_id: lead.id,
                reason: input.reason,
                notes,
                urgency: input.urgency,
                suggested_action: input.suggested_action?.trim() || null,
            };
            const lines: Preview["lines"] = [
                { label: "Reason", value: reasonLabel(plan.reason) },
                { label: "Urgency", value: plan.urgency },
                { label: "Notes", value: plan.notes },
            ];
            if (plan.suggested_action) lines.push({ label: "Suggested", value: plan.suggested_action });
            lines.push({
                label: "Notifies",
                value: plan.urgency === "urgent" ? "admin, sales head, partner and CEO" : "admin, sales head and partner",
            });
            const preview: Preview = {
                title: `Escalate — ${lead.shop_name || lead.dealer_name || lead.id}`,
                lines,
                resets_idle_clock: isWorkedTouchpoint("escalation_raised", false),
                warning: null,
                needs_second_confirm: false,
                crm_url: crmUrl,
            };
            const { id } = await createPending({
                userId: ctx.user.id,
                tool: "escalate_lead",
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

export const escalateLeadApplier = defineApplier<EscalateLeadPlan>({
    schema: EscalateLeadPlan,
    apply: async ({ tx, user }, p) => {
        const { escalationId, notify } = await escalateLeadWrite(
            {
                leadId: p.lead_id,
                actor: { id: user.id, name: user.name },
                reason: p.reason,
                notes: p.notes,
                suggestedAction: p.suggested_action,
                urgency: p.urgency,
            },
            { tx },
        );
        return { escalation_id: escalationId, afterCommit: notify };
    },
});
