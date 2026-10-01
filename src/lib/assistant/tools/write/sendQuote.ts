// send_quote — send the lead's latest quote to the dealer: the Send button on
// the lead screen (QuotationSendDialog), through the same writer
// (lib/leads/sendQuotation.ts). PROPOSES only: the preview names the quote and
// exactly who will receive it. Recipients are the lead's own phone / email —
// never a number typed into the chat.
//
// Only an approved quote with a generated PDF can go (the E-242 gate, checked
// here for the preview and again by sendApprovedQuotation at send time). The
// send is external and cannot roll back, so the applier writes nothing in the
// transaction — it runs in afterCommit, like invite_dealer_onboarding, and the
// per-channel delivery comes back on the confirmed outcome for the reply.

import { z } from "zod";
import { assertSendable, loadQuote, QuotationNotSendableError } from "@/lib/leads/quoteSendGate";
import { createPending } from "../../actions";
import type { Preview, ToolResult } from "../../types";
import { defineTool, LeadId, NOT_FOUND, ownedLeadOr, type ToolFactory } from "../spec";
import { leadUrl } from "../leads";
import { defineApplier } from "../../applierSpec";
import { APPROVAL_LABEL, inr, loadLatestQuote } from "../quotes";

/** quoteDispatch's QUOTE_DISPATCH_CHANNELS — restated so this module stays off the provider stack. */
const CHANNELS = ["whatsapp", "email"] as const;

export const SendQuotePlan = z.object({
    lead_id: z.string().min(1),
    commercial_id: z.string().min(1),
    quote_number: z.string().min(1),
    channels: z.array(z.enum(CHANNELS)).min(1),
});
export type SendQuotePlan = z.infer<typeof SendQuotePlan>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const sendQuote: ToolFactory = () =>
    defineTool({
        name: "send_quote",
        kind: "write",
        description:
            "Propose sending the lead's latest APPROVED quote (its PDF) to the dealer on WhatsApp and/or email, to the " +
            "phone / email saved on the lead. Only when the user asks. Nothing is sent until Confirm.",
        schema: z.object({
            lead_id: LeadId,
            channels: z
                .array(z.enum(CHANNELS))
                .min(1)
                .max(2)
                .optional()
                .describe("Default: WhatsApp, plus email when the lead has an email address"),
        }),
        run: async (ctx, input): Promise<ToolResult> => {
            const owned = await ownedLeadOr(ctx, input.lead_id);
            if (owned.result) return owned.result;
            const lead = owned.lead;
            const crmUrl = leadUrl(ctx.user, lead.id);

            const latest = await loadLatestQuote(lead.id);
            if (!latest) {
                return { kind: "declined", reason: "This lead has no quote yet. Create one first.", crm_url: crmUrl };
            }
            const row = await loadQuote(lead.id, latest.commercial_id);
            try {
                assertSendable(row);
            } catch (err) {
                if (!(err instanceof QuotationNotSendableError)) throw err;
                if (err.reason === "not_found") return NOT_FOUND;
                const why =
                    err.reason === "no_draft"
                        ? `Quote v${latest.version_no} is approved but its PDF isn't ready yet. Regenerate it on the CRM screen.`
                        : latest.approval_status === "rejected"
                          ? `Quote v${latest.version_no} was rejected by the CEO` +
                            (latest.rejection_reason ? ` (${latest.rejection_reason})` : "") +
                            ". Revise it first."
                          : `Quote v${latest.version_no} is ${(APPROVAL_LABEL[latest.approval_status ?? ""] ?? "not approved").toLowerCase()}, so it can't be sent yet.`;
                return { kind: "declined", reason: why, crm_url: crmUrl };
            }

            const email = row.dealer_email?.trim() || null;
            const phone = row.dealer_phone?.trim() || null;
            const channels = input.channels ?? (email && EMAIL_RE.test(email) ? ["whatsapp", "email"] : ["whatsapp"]);
            if (channels.includes("whatsapp") && !phone) {
                return { kind: "declined", reason: "This lead has no phone number for WhatsApp.", crm_url: crmUrl };
            }
            if (channels.includes("email") && !(email && EMAIL_RE.test(email))) {
                return {
                    kind: "declined",
                    reason: "This lead has no valid email address. Send on WhatsApp, or add the email on the CRM screen.",
                    crm_url: crmUrl,
                };
            }

            const plan: SendQuotePlan = {
                lead_id: lead.id,
                commercial_id: row.commercial_id,
                quote_number: row.quote_number,
                channels,
            };
            const total = row.quote_total == null ? null : Number(row.quote_total);
            const lines: Preview["lines"] = [
                { label: "Quote", value: `${row.quote_number} (v${row.version_no})` },
            ];
            if (total != null && Number.isFinite(total)) lines.push({ label: "Total (incl. GST)", value: inr(total) });
            if (channels.includes("whatsapp")) lines.push({ label: "WhatsApp", value: phone! });
            if (channels.includes("email")) lines.push({ label: "Email", value: email! });
            if (row.dealer_decision) {
                lines.push({ label: "Dealer already", value: row.dealer_decision.replace(/_/g, " ") });
            }
            const preview: Preview = {
                title: `Send quote — ${lead.shop_name || lead.dealer_name || lead.id}`,
                lines,
                resets_idle_clock: false,
                warning: "This sends the dealer the quotation PDF.",
                needs_second_confirm: false,
                crm_url: crmUrl,
            };
            const { id } = await createPending({
                userId: ctx.user.id,
                tool: "send_quote",
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

export const sendQuoteApplier = defineApplier<SendQuotePlan>({
    schema: SendQuotePlan,
    apply: async ({ user }, p) => ({
        afterCommit: async () => {
            try {
                // Loaded here, not at module scope: it pulls the PDF / storage /
                // provider stack, which the registry must not load per message.
                const { sendApprovedQuotation } = await import("@/lib/leads/sendQuotation");
                const res = await sendApprovedQuotation({
                    leadId: p.lead_id,
                    commercialId: p.commercial_id,
                    channels: p.channels,
                    actor: { id: user.id, name: user.name },
                });
                return {
                    quote_number: res.quote_number,
                    sent: res.outcomes.filter((o) => o.status === "sent").map((o) => o.channel),
                    failed: res.outcomes.filter((o) => o.status === "failed").map((o) => o.channel),
                    error: null,
                };
            } catch (err) {
                // The quote changed between preview and Confirm (rejected by a
                // later revision, PDF gone) or the send blew up: nothing went.
                return {
                    quote_number: p.quote_number,
                    sent: [],
                    failed: p.channels,
                    error:
                        err instanceof QuotationNotSendableError
                            ? err.message
                            : "The send failed. Try again, or send it from the CRM screen.",
                };
            }
        },
    }),
});
