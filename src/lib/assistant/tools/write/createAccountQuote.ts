// create_account_quote (ID 211) — a quotation on a dealer ACCOUNT over
// WhatsApp, with the account page's rules: only the account's owner (or their
// ASM) may quote; CEO approval when the price or credit needs it; the PDF is
// made on approval; never an OEM price in the reply; no deal card (an account
// is an onboarded dealer). PROPOSES only: the preview shows the lines, total,
// terms and auto / CEO. createAccountQuoteApplier writes through
// createAccountQuotation() — the account route's own writer — inside the
// executor's transaction, after checking access again at Confirm.
//
// Products come ONLY from the catalogue (product_catalogue's product_id).
// Price, quantity and payment terms come only from the rep — a missing one is
// a question.

import { z } from "zod";
import { loadLiveOemPrices } from "@/lib/leads/oemPrices";
import { evaluateAgainstOemPrices, linesNeedingAttention } from "@/lib/leads/oemPricing";
import { MAX_CREDIT_DAYS, QuoteTermsSchema, formatCreditTerms, getStandardQuoteTerms } from "@/lib/leads/quoteTerms";
import { createPending } from "../../actions";
import { defineApplier } from "../../applierSpec";
import type { Preview, ToolResult } from "../../types";
import { AccountId, accountInScopeOr, accountUrl } from "../accounts";
import { defineTool, WRITES_OFF, type ToolFactory } from "../spec";
import { inr, loadCatalogue } from "../quotes";
import { quoteTotal } from "./createQuote";

export const CreateAccountQuotePlan = z.object({
    account_id: z.string().min(1),
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
    terms: QuoteTermsSchema,
    notes: z.string().nullable(),
});
export type CreateAccountQuotePlan = z.infer<typeof CreateAccountQuotePlan>;

const ask = (question: string): ToolResult => ({ kind: "question", question });

export const createAccountQuote: ToolFactory = () =>
    defineTool({
        name: "create_account_quote",
        kind: "write",
        description:
            "Propose a quotation on a dealer ACCOUNT (account_id from my_dealers) the user may quote on: product lines " +
            "from product_catalogue with the quantity and unit price (₹, before GST) the user gave, and the dealer payment " +
            "terms (cash, or credit with a number of days). No deal card. Any credit needs CEO approval. Shows whether it " +
            "will be auto-approved or needs CEO approval. Nothing is saved until Confirm.",
        schema: z.object({
            account_id: AccountId,
            lines: z
                .array(
                    z.object({
                        product_id: z.string().trim().min(1).max(64).describe("product_id from product_catalogue — never invented"),
                        quantity: z.number().int().min(1).max(100000).optional(), // not .positive(): exclusiveMinimum 400s Gemini
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
            payment_terms: z.enum(["cash", "credit"]).optional().describe("Dealer payment terms, exactly as the user said — never assumed"),
            credit_days: z.number().int().min(1).max(MAX_CREDIT_DAYS).optional().describe("Days of credit, only when payment_terms is credit"),
            notes: z.string().trim().min(1).max(2000).optional(),
        }),
        run: async (ctx, input): Promise<ToolResult> => {
            if (!ctx.writesEnabled) return WRITES_OFF;
            const scoped = await accountInScopeOr(ctx, input.account_id, "create");
            if (scoped.result) return scoped.result;
            const { account } = scoped.access;
            const crmUrl = accountUrl(account.id);

            const catalogue = await loadCatalogue();
            const byId = new Map(catalogue.map((p) => [p.product_id, p]));
            const lines: CreateAccountQuotePlan["product_lines"] = [];
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
            if (!input.payment_terms) return ask("Payment terms for the dealer — cash, or credit (how many days)?");
            if (input.payment_terms === "credit" && !input.credit_days) return ask(`How many days of credit (1–${MAX_CREDIT_DAYS})?`);

            const credit = input.payment_terms === "credit";
            const plan: CreateAccountQuotePlan = {
                account_id: account.id,
                product_lines: lines,
                terms: { dealer_payment_terms: input.payment_terms, credit_days: credit ? (input.credit_days ?? null) : null },
                notes: input.notes ?? null,
            };

            // A forecast only — the writer re-runs the gate at Confirm. No rupee reference leaves this block.
            const refs = await loadLiveOemPrices(lines, undefined, ctx.now);
            const evaluation = evaluateAgainstOemPrices(lines, refs, ctx.now);
            const priceOk = evaluation.outcome === "auto_approved";
            const auto = priceOk && !credit;
            const flagged = linesNeedingAttention(evaluation);
            const standard = await getStandardQuoteTerms();
            const total = quoteTotal(lines);

            const out: Preview["lines"] = [
                { label: "Total (before GST)", value: inr(total) },
                { label: "Approval", value: auto ? "Auto-approved on Confirm — PDF made, ready to send" : "Goes to the CEO for approval" },
                ...lines.map((l, i) => ({
                    label: `Item ${i + 1}`,
                    value: `${l.quantity} × ${l.product_name} @ ${inr(l.unit_price)} = ${inr(l.unit_price * l.quantity)}`,
                })),
                { label: "Payment terms", value: formatCreditTerms(input.payment_terms, plan.terms.credit_days ?? null) },
                { label: "Warranty", value: standard.warranty },
                { label: "Delivery", value: standard.delivery },
            ];
            if (plan.notes) out.push({ label: "Notes", value: plan.notes });

            const preview: Preview = {
                title: `Quote — ${account.name} (dealer account)`,
                lines: out,
                resets_idle_clock: false,
                warning: auto
                    ? null
                    : "Needs CEO approval: " +
                      [
                          priceOk ? null : `${flagged} line${flagged === 1 ? " is" : "s are"} below the reference price or without one`,
                          credit ? `credit terms (${plan.terms.credit_days} days)` : null,
                      ]
                          .filter(Boolean)
                          .join("; ") +
                      ". It can't be sent to the dealer until approved.",
                needs_second_confirm: false,
                crm_url: crmUrl,
            };
            const { id } = await createPending({
                userId: ctx.user.id,
                tool: "create_account_quote",
                leadId: null,
                leadVersion: null,
                plan,
                preview,
                before: { account_id: account.id, owner_id: account.owner_id },
                sourceMessageId: ctx.messageId,
            });
            return { kind: "preview", action_id: id, preview };
        },
    });

export const createAccountQuoteApplier = defineApplier<CreateAccountQuotePlan>({
    schema: CreateAccountQuotePlan,
    // No lead: the applier checks the account itself, again, at Confirm (the
    // owner may have changed since the preview).
    ownership: "none",
    apply: async ({ tx, user }, p) => {
        const { assertAccountQuoteAccess } = await import("@/lib/accounts/quotations/access");
        const { createAccountQuotation } = await import("@/lib/accounts/quotations/create");
        const { account } = await assertAccountQuoteAccess(user, p.account_id, "create");
        const res = await createAccountQuotation(
            {
                account,
                actor: { id: user.id, name: user.name },
                body: { product_lines: p.product_lines, terms: p.terms, notes: p.notes },
            },
            { tx },
        );
        return {
            quotation_id: res.quotationId,
            quote_version: res.versionNo,
            approval_status: res.approvalStatus,
            auto_approved: res.autoApproved,
            // PDF / CEO email / notices — after COMMIT, best-effort.
            afterCommit: () => res.afterCommit(),
        };
    },
});
