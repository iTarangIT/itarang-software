// mark_converted — close a lead the user owns as Converted (BRD §0.7 / §0.13),
// with the dealer's GSTIN (required, as on the screen). PROPOSES only. On
// Confirm, markConvertedApplier runs markLeadConverted() — the route's own
// writer — on the executor's transaction: status, GSTIN and the draft dealer
// onboarding application commit together; notifications go out after commit.
// Undoing a conversion stays on the CRM screen.
//
// The confirmed reply offers a "Send invite" button (ast:inv:<leadId>), which
// only PROPOSES invite_dealer_onboarding — its own Confirm sends.

import { z } from "zod";
import { isValidGstin, normalizeGstin } from "@/lib/leads/gstin";
import { markLeadConverted } from "@/lib/leads/markConverted";
import { isWorkedTouchpoint } from "@/lib/lifecycle/touchpointTypes";
import { createPending } from "../../actions";
import { statusLabel } from "../../format";
import type { Preview, ToolResult } from "../../types";
import { defineTool, LeadId, ownedLeadOr, type ToolFactory } from "../spec";
import { leadUrl } from "../leads";
import { defineApplier } from "../../applierSpec";
import { Remarks } from "./vocabSchemas";

export const MarkConvertedPlan = z.object({
    lead_id: z.string().min(1),
    gstin: z.string().refine(isValidGstin),
    notes: z.string().nullable(),
});
export type MarkConvertedPlan = z.infer<typeof MarkConvertedPlan>;

const ask = (question: string): ToolResult => ({ kind: "question", question });

export const markConverted: ToolFactory = () =>
    defineTool({
        name: "mark_converted",
        kind: "write",
        description:
            "Propose marking a lead the user owns as Converted. Needs the dealer's 15-character GSTIN — ask for it, never " +
            "invent one. Creates the dealer onboarding application. Nothing is saved until Confirm.",
        schema: z.object({
            lead_id: LeadId,
            gstin: z.string().trim().max(40).describe("The dealer's GSTIN exactly as the user gave it"),
            notes: Remarks.optional(),
        }),
        run: async (ctx, input): Promise<ToolResult> => {
            const owned = await ownedLeadOr(ctx, input.lead_id);
            if (owned.result) return owned.result;
            const lead = owned.lead;
            const crmUrl = leadUrl(ctx.user, lead.id);

            if (lead.lead_status === "Converted") {
                return { kind: "declined", reason: "This lead is already Converted.", crm_url: crmUrl };
            }
            const gstin = normalizeGstin(input.gstin);
            if (!isValidGstin(gstin)) {
                return ask("That GSTIN doesn't look right. What is the dealer's 15-character GSTIN (e.g. 07AAACB1234C1Z5)?");
            }

            const plan: MarkConvertedPlan = { lead_id: lead.id, gstin, notes: input.notes?.trim() || null };
            const lines: Preview["lines"] = [
                { label: "Status", value: `${statusLabel(lead.lead_status)} → Converted` },
                { label: "GSTIN", value: gstin },
            ];
            if (plan.notes) lines.push({ label: "Notes", value: plan.notes });
            lines.push({ label: "Creates", value: "the dealer onboarding application" });
            const preview: Preview = {
                title: `Mark Converted — ${lead.shop_name || lead.dealer_name || lead.id}`,
                lines,
                resets_idle_clock: isWorkedTouchpoint("status_change_note", true),
                warning: "Undoing a conversion can only be done on the CRM screen.",
                needs_second_confirm: false,
                crm_url: crmUrl,
            };
            const { id } = await createPending({
                userId: ctx.user.id,
                tool: "mark_converted",
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

export const markConvertedApplier = defineApplier<MarkConvertedPlan>({
    schema: MarkConvertedPlan,
    apply: async ({ tx, user }, p) => {
        const { applicationId, notify } = await markLeadConverted(
            { leadId: p.lead_id, actor: { id: user.id, name: user.name, role: user.role }, gstin: p.gstin, notes: p.notes },
            { tx },
        );
        return { onboarding_application_id: applicationId, afterCommit: notify };
    },
});
