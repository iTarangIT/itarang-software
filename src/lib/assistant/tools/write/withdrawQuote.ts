// withdraw_quote — close the lead's latest quote with a reason: the Withdraw
// button on the lead screen (tracker ID 78), through the same writer
// (lib/leads/withdrawQuote.ts). PROPOSES only: the preview names the quote and
// the reason; withdrawQuoteApplier writes from the executor, in its transaction.
//
// "The latest quote" is loadLatestQuote's "in_play" pick — the newest quote
// that is not withdrawn and is approved or still waiting for the CEO. The refusals are
// the writer's own (withdrawRefusal): a rejected quote has nothing to withdraw,
// and a quote the dealer approved is closed with Mark Won / Mark Lost, never
// withdrawn. What happens to the lead is the writer's decision too — it goes
// back to Under discussion only when no other quote is left in play.

import { z } from "zod";
import { withdrawQuote as withdrawLeadQuote, withdrawRefusal } from "@/lib/leads/withdrawQuote";
import { createPending } from "../../actions";
import { statusLabel } from "../../format";
import type { Preview, ToolResult } from "../../types";
import { defineTool, LeadId, ownedLeadOr, type ToolFactory } from "../spec";
import { leadUrl } from "../leads";
import { defineApplier } from "../../applierSpec";
import { APPROVAL_LABEL, inr, loadLatestQuote } from "../quotes";

/** The route's own bounds (POST …/commercials/[commercialId]/withdraw). */
const REASON_MIN = 5;
const REASON_MAX = 1000;

export const WithdrawQuotePlan = z.object({
    lead_id: z.string().min(1),
    commercial_id: z.string().min(1),
    quote_number: z.string().nullable(),
    version_no: z.number().int().positive(),
    reason: z.string().min(REASON_MIN).max(REASON_MAX),
});
export type WithdrawQuotePlan = z.infer<typeof WithdrawQuotePlan>;

export const withdrawQuote: ToolFactory = () =>
    defineTool({
        name: "withdraw_quote",
        kind: "write",
        description:
            "Propose withdrawing the lead's latest quote (approved, or still waiting for the CEO) with the user's reason, " +
            "so the dealer can no longer answer it. Only when the user asks to withdraw / cancel / take back a quote. " +
            "Nothing is saved until Confirm.",
        schema: z.object({
            lead_id: LeadId,
            reason: z.string().trim().max(REASON_MAX).optional().describe("Why the quote is being withdrawn, in the user's words"),
        }),
        run: async (ctx, input): Promise<ToolResult> => {
            const owned = await ownedLeadOr(ctx, input.lead_id);
            if (owned.result) return owned.result;
            const lead = owned.lead;
            const crmUrl = leadUrl(ctx.user, lead.id);

            // The version a withdrawal closes is the newest one still in play.
            // A rejected revision above a live quote is not it; with nothing in
            // play the newest quote gives the refusal its reason.
            const latest = (await loadLatestQuote(lead.id, "in_play")) ?? (await loadLatestQuote(lead.id));
            if (!latest) {
                return { kind: "declined", reason: "This lead has no open quote to withdraw.", crm_url: crmUrl };
            }
            const refusal = withdrawRefusal({
                event_type: latest.event_type,
                approval_status: latest.approval_status,
                dealer_decision: latest.dealer_decision,
                // loadLatestQuote never returns a withdrawn quote.
                withdrawn_at: null,
                lead_status: lead.lead_status,
            });
            if (refusal) return { kind: "declined", reason: refusal.message, crm_url: crmUrl };

            const reason = input.reason?.trim() ?? "";
            if (reason.length < REASON_MIN) {
                return { kind: "question", question: "Why is this quote being withdrawn? I need a short reason." };
            }

            const plan: WithdrawQuotePlan = {
                lead_id: lead.id,
                commercial_id: latest.commercial_id,
                quote_number: latest.quote_number,
                version_no: latest.version_no,
                reason,
            };
            const state = APPROVAL_LABEL[latest.approval_status ?? ""] ?? "Quote";
            const lines: Preview["lines"] = [
                {
                    label: "Quote",
                    value:
                        `${latest.quote_number ?? "Quote"} (v${latest.version_no}) · ${state}` +
                        (latest.total != null ? ` · ${inr(latest.total)}` : ""),
                },
                { label: "Reason", value: reason },
                { label: "Lead status now", value: statusLabel(lead.lead_status) },
            ];
            const preview: Preview = {
                title: `Withdraw quote — ${lead.shop_name || lead.dealer_name || lead.id}`,
                lines,
                // A withdrawal is work on the lead (it writes a status note).
                resets_idle_clock: true,
                warning:
                    "The dealer can no longer answer this quote. If no other quote is open, the lead goes back to Under discussion.",
                needs_second_confirm: false,
                crm_url: crmUrl,
            };
            const { id } = await createPending({
                userId: ctx.user.id,
                tool: "withdraw_quote",
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

export const withdrawQuoteApplier = defineApplier<WithdrawQuotePlan>({
    schema: WithdrawQuotePlan,
    apply: async ({ tx, user }, p) => {
        // Re-checked by the writer against the row it locks: a quote the dealer
        // approved, or one withdrawn, between the preview and Confirm is refused
        // there and the action ends failed with that sentence.
        const res = await withdrawLeadQuote(
            { leadId: p.lead_id, commercialId: p.commercial_id, actorId: user.id, reason: p.reason },
            { tx },
        );
        return {
            quote_number: res.quoteNumber,
            lead_status: res.leadStatus,
            live_quote_version: res.liveQuote?.versionNo ?? null,
        };
    },
});
