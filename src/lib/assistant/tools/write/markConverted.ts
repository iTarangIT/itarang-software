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
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { checkCustomerGstin, normalizeGstin } from "@/lib/leads/gstin";
import { markLeadConverted } from "@/lib/leads/markConverted";
import { checkStatusMove } from "@/lib/lifecycle/statusRules";
import { isWorkedTouchpoint } from "@/lib/lifecycle/touchpointTypes";
import { createPending } from "../../actions";
import { statusLabel } from "../../format";
import type { Preview, ToolResult } from "../../types";
import { defineTool, LeadId, ownedLeadOr, type ToolFactory } from "../spec";
import { leadUrl } from "../leads";
import { defineApplier } from "../../applierSpec";
import { Remarks } from "./vocabSchemas";
import { gstinQuestion } from "./updateLead";

export const MarkConvertedPlan = z.object({
    lead_id: z.string().min(1),
    // ID 62 — a stored plan must pass the same rule the question used (own GSTIN refused).
    gstin: z.string().refine((g) => checkCustomerGstin(g) === "ok"),
    notes: z.string().nullable(),
});
export type MarkConvertedPlan = z.infer<typeof MarkConvertedPlan>;

const ask = (question: string): ToolResult => ({ kind: "question", question });

/**
 * ID 74: does the lead have a dealer-approved, not-withdrawn quote? The same
 * EXISTS attachOnboardingToWonLead writes won_without_approved_quote from.
 */
async function hasDealerApprovedQuote(leadId: string): Promise<boolean> {
    const rows = (await db.execute<{ ok: boolean }>(sql`
        SELECT EXISTS (
            SELECT 1 FROM dealer_lead_commercials c
             WHERE c.dealer_lead_id = ${leadId}
               AND c.event_type IN ('quote_issue', 'quote_revision')
               AND c.dealer_decision = 'approved'
               AND c.withdrawn_at IS NULL) AS ok
    `)) as unknown as Array<{ ok: boolean }>;
    return rows[0]?.ok === true;
}

export const markConverted: ToolFactory = () =>
    defineTool({
        name: "mark_converted",
        kind: "write",
        description:
            "Propose marking a lead the user owns as Won (it becomes Converted when the dealer's onboarding is approved). Needs the dealer's 15-character GSTIN — ask for it, never " +
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

            if (lead.lead_status === "Converted" || lead.lead_status === "Won") {
                return { kind: "declined", reason: `This lead is already ${lead.lead_status}.`, crm_url: crmUrl };
            }
            // The S3 rule the writer enforces (a Lost lead cannot be marked Won) — refused now, not after Confirm.
            const verdict = checkStatusMove({ from: lead.lead_status, to: "Won", event: "mark_won" });
            if (!verdict.ok) return { kind: "declined", reason: verdict.reason, crm_url: crmUrl };
            const gstin = normalizeGstin(input.gstin);
            const gstinAsk = gstinQuestion(gstin);
            if (gstinAsk) return ask(gstinAsk);
            // ID 74: the same test the writer flags with (won_without_approved_quote).
            const approvedQuote = await hasDealerApprovedQuote(lead.id);

            const plan: MarkConvertedPlan = { lead_id: lead.id, gstin, notes: input.notes?.trim() || null };
            const lines: Preview["lines"] = [
                { label: "Status", value: `${statusLabel(lead.lead_status)} → Won` },
                { label: "GSTIN", value: gstin },
            ];
            if (plan.notes) lines.push({ label: "Notes", value: plan.notes });
            lines.push({ label: "Creates", value: "the dealer onboarding application" });
            const preview: Preview = {
                title: `Mark Won — ${lead.shop_name || lead.dealer_name || lead.id}`,
                lines,
                resets_idle_clock: isWorkedTouchpoint("status_change_note", true),
                warning:
                    (approvedQuote
                        ? ""
                        : "No dealer-approved quote on this lead. You can still mark it Won; it will be flagged " +
                          "Won without an approved quote for the admin and sales head. ") +
                    "Undoing a conversion can only be done on the CRM screen.",
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
