// create_quote — raise a quote (or a revision) on a lead the user owns: the
// Update Commercials modal's quote_issue / quote_revision, over WhatsApp (gap
// table C). PROPOSES only: the preview shows each product line, the total and
// the terms, plus whether the quote will auto-approve or go to the CEO.
// createQuoteApplier writes through createLeadCommercial() — the commercials
// route's own writer — inside the executor's transaction, so the E-226 OEM
// price gate that decides approval is the one the screen runs.
//
// Products come ONLY from the catalogue (product_catalogue's product_id): the
// name, model and asset type on the line are the server's, never the model's.
// Price and quantity come only from the rep — a missing one is a question.
// The approval forecast never shows a reference price: it says auto or CEO.

import { z } from "zod";
import { loadLiveOemPrices } from "@/lib/leads/oemPrices";
import { evaluateAgainstOemPrices, linesNeedingAttention } from "@/lib/leads/oemPricing";
import type { CommercialsProductLine } from "@/lib/inside-sales/types";
import { createPending } from "../../actions";
import type { Preview, ToolResult } from "../../types";
import { defineTool, LeadId, ownedLeadOr, type ToolFactory } from "../spec";
import { leadUrl } from "../leads";
import { defineApplier } from "../../applierSpec";
import { APPROVAL_LABEL, inr, loadCatalogue, loadLatestQuote } from "../quotes";

const Terms = z.string().trim().min(1).max(2000);

export const CreateQuotePlan = z.object({
    lead_id: z.string().min(1),
    event_type: z.enum(["quote_issue", "quote_revision"]),
    product_lines: z
        .array(
            z.object({
                asset_type: z.enum(["battery", "charger", "paraphernalia"]),
                product_id: z.string().min(1),
                product_name: z.string().min(1),
                model_id: z.string(),
                unit_price: z.number().nonnegative(),
                quantity: z.number().int().positive(),
            }),
        )
        .min(1),
    final_price: z.number().nonnegative(),
    credit_terms: z.string().nullable(),
    delivery_terms: z.string().nullable(),
    warranty_terms: z.string().nullable(),
    payment_method: z.enum(["cash", "finance"]).nullable(),
    deal_notes: z.string().nullable(),
});
export type CreateQuotePlan = z.infer<typeof CreateQuotePlan>;

const ask = (question: string): ToolResult => ({ kind: "question", question });

/** Σ price × qty, in paise so 0.1 + 0.2 never shows up on a quote. */
export function quoteTotal(lines: Pick<CommercialsProductLine, "unit_price" | "quantity">[]): number {
    const paise = lines.reduce((s, l) => s + Math.round((l.unit_price ?? 0) * 100) * l.quantity, 0);
    return paise / 100;
}

export const createQuote: ToolFactory = () =>
    defineTool({
        name: "create_quote",
        kind: "write",
        description:
            "Propose a quote (or a revised quote, when the lead already has one) on a lead the user owns: product lines " +
            "from product_catalogue with the quantity and unit price (₹, before GST) the user gave, plus optional terms. " +
            "Shows whether it will be auto-approved or needs CEO approval. Nothing is saved until Confirm.",
        schema: z.object({
            lead_id: LeadId,
            lines: z
                .array(
                    z.object({
                        product_id: z.string().trim().min(1).max(64).describe("product_id from product_catalogue — never invented"),
                        quantity: z.number().int().positive().max(100000).optional(),
                        unit_price: z
                            .number()
                            .nonnegative()
                            .max(100_000_000)
                            .optional()
                            .describe("Rupees per unit before GST, exactly as the user said"),
                    }),
                )
                .min(1)
                .max(20),
            credit_terms: Terms.optional(),
            delivery_terms: Terms.optional(),
            warranty_terms: Terms.optional(),
            payment_method: z.enum(["cash", "finance"]).optional(),
            deal_notes: Terms.optional(),
        }),
        run: async (ctx, input): Promise<ToolResult> => {
            const owned = await ownedLeadOr(ctx, input.lead_id);
            if (owned.result) return owned.result;
            const lead = owned.lead;
            const crmUrl = leadUrl(ctx.user, lead.id);

            // Every product re-resolved against the ACTIVE catalogue.
            const catalogue = await loadCatalogue();
            const byId = new Map(catalogue.map((p) => [p.product_id, p]));
            const lines: CreateQuotePlan["product_lines"] = [];
            for (const l of input.lines) {
                const p = byId.get(l.product_id);
                if (!p) {
                    return {
                        kind: "declined",
                        reason: "One of those products isn't in the active catalogue. Look it up with product_catalogue first.",
                        crm_url: crmUrl,
                    };
                }
                if (l.quantity == null) return ask(`How many ${p.product_name}?`);
                if (l.unit_price == null) return ask(`What price per unit (before GST) for ${p.product_name}?`);
                lines.push({
                    asset_type: p.asset_type,
                    product_id: p.product_id,
                    product_name: p.product_name,
                    model_id: p.model_id,
                    unit_price: l.unit_price,
                    quantity: l.quantity,
                });
            }
            const seen = new Set<string>();
            for (const l of lines) {
                const k = `${l.asset_type}:${l.product_id}`;
                if (seen.has(k)) return ask(`${l.product_name} is on the quote twice. One line with the total quantity?`);
                seen.add(k);
            }

            const previous = await loadLatestQuote(lead.id);
            const plan: CreateQuotePlan = {
                lead_id: lead.id,
                event_type: previous ? "quote_revision" : "quote_issue",
                product_lines: lines,
                final_price: quoteTotal(lines),
                credit_terms: input.credit_terms ?? null,
                delivery_terms: input.delivery_terms ?? null,
                warranty_terms: input.warranty_terms ?? null,
                payment_method: input.payment_method ?? null,
                deal_notes: input.deal_notes ?? null,
            };

            // A forecast only — the executor re-runs the gate inside its
            // transaction, against the prices live at that instant, and that is
            // the verdict that counts. No rupee figure leaves this block.
            const refs = await loadLiveOemPrices(lines, undefined, ctx.now);
            const evaluation = evaluateAgainstOemPrices(lines, refs, ctx.now);
            const auto = evaluation.outcome === "auto_approved";
            const flagged = linesNeedingAttention(evaluation);

            // Total and approval first: a long quote is cut from the END to fit
            // the WhatsApp card, and these two must always survive.
            const out: Preview["lines"] = [
                { label: "Total (before GST)", value: inr(plan.final_price) },
                {
                    label: "Approval",
                    value: auto ? "Auto-approved on Confirm — PDF made, ready to send" : "Goes to the CEO for approval",
                },
                ...lines.map((l, i) => ({
                    label: `Item ${i + 1}`,
                    value: `${l.quantity} × ${l.product_name} @ ${inr(l.unit_price)} = ${inr(l.unit_price * l.quantity)}`,
                })),
            ];
            if (plan.payment_method) out.push({ label: "Payment", value: plan.payment_method === "cash" ? "Cash" : "Finance" });
            if (plan.credit_terms) out.push({ label: "Credit terms", value: plan.credit_terms });
            if (plan.delivery_terms) out.push({ label: "Delivery", value: plan.delivery_terms });
            if (plan.warranty_terms) out.push({ label: "Warranty", value: plan.warranty_terms });
            if (plan.deal_notes) out.push({ label: "Notes", value: plan.deal_notes });
            if (previous) {
                out.push({
                    label: "Replaces",
                    value:
                        `v${previous.version_no}` +
                        (previous.total != null ? ` (${inr(previous.total)})` : "") +
                        ` — ${APPROVAL_LABEL[previous.approval_status ?? "approved"] ?? previous.approval_status}`,
                });
            }

            const name = lead.shop_name || lead.dealer_name || lead.id;
            const preview: Preview = {
                title: `${previous ? "Revised quote" : "Quote"} — ${name}`,
                lines: out,
                // Quotes are not "worked" touchpoints (isWorkedTouchpoint).
                resets_idle_clock: false,
                warning: auto
                    ? null
                    : `Needs CEO approval: ${flagged} line${flagged === 1 ? " is" : "s are"} below the reference price or ` +
                      "without one. It can't be sent to the dealer until approved.",
                needs_second_confirm: false,
                crm_url: crmUrl,
            };
            const { id } = await createPending({
                userId: ctx.user.id,
                tool: "create_quote",
                leadId: lead.id,
                leadVersion: lead.updated_at,
                plan,
                preview,
                before: previous
                    ? { quote_version: previous.version_no, quote_total: previous.total, quote_approval: previous.approval_status }
                    : {},
                sourceMessageId: ctx.messageId,
            });
            return { kind: "preview", action_id: id, preview };
        },
    });

export const createQuoteApplier = defineApplier<CreateQuotePlan>({
    schema: CreateQuotePlan,
    apply: async ({ tx, user }, p) => {
        // Loaded here, not at module scope: its post-commit half pulls the PDF /
        // storage stack, which the registry must not load per message.
        const { createLeadCommercial } = await import("@/lib/leads/createCommercial");
        const res = await createLeadCommercial(
            {
                leadId: p.lead_id,
                actor: { id: user.id, name: user.name },
                body: {
                    event_type: p.event_type,
                    product_lines: p.product_lines,
                    final_price: p.final_price,
                    credit_terms: p.credit_terms,
                    delivery_terms: p.delivery_terms,
                    warranty_terms: p.warranty_terms,
                    payment_method: p.payment_method,
                    deal_notes: p.deal_notes,
                },
            },
            { tx },
        );
        return {
            commercial_id: res.commercialId,
            quote_version: res.versionNo,
            approval_status: res.approvalStatus,
            auto_approved: res.autoApproved,
            // Draft PDF, touchpoint, notifications — after COMMIT, best-effort.
            afterCommit: res.afterCommit,
        };
    },
});
