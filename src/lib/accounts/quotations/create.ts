/**
 * E-358 — raise a new version of an ACCOUNT quotation.
 *
 * The same gate as a lead quote (src/lib/leads/createCommercial.ts), reused,
 * not restated: every line is judged against its OEM reference price in force
 * at the instant the quote is stamped (evaluateAgainstOemPrices →
 * resolveQuoteApproval), credit terms always hold it for the CEO
 * (applyTermsHold), and the printed list price is snapshotted. What differs is
 * only the key: account_quotations by account_id, never a lead.
 *
 * The caller has already checked access (assertAccountQuoteAccess). The draft
 * PDF and notifications run in `afterCommit`, once the transaction committed,
 * so a rendering failure can never undo an approval the rule granted.
 */
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { accountQuotations } from "@/lib/db/schema";
import type { CommercialsProductLine } from "@/lib/inside-sales/types";
import { loadLiveOemPrices } from "@/lib/leads/oemPrices";
import { loadLiveListPrices, snapshotListPrices } from "@/lib/leads/listPrices";
import {
    evaluateAgainstOemPrices,
    linesNeedingAttention,
    resolveQuoteApproval,
    type OemEvaluation,
} from "@/lib/leads/oemPricing";
import {
    applyTermsHold,
    getStandardQuoteTerms,
    QuoteTermsSchema,
    resolveQuoteTerms,
    termsHold,
    type TermsHold,
} from "@/lib/leads/quoteTerms";
import { AccountQuoteError, type AccountSummary } from "./access";
import { tryGenerateAccountQuotationDraft } from "./draft";
import { notifyAccountQuotationApproved, notifyAccountQuotationPendingApproval } from "./notify";
import { sendQuoteApprovalRequestEmail, termsLabel } from "@/lib/leads/quoteApprovalEmail";

export const AccountQuoteLineSchema = z.object({
    asset_type: z.enum(["battery", "charger", "paraphernalia"]),
    product_id: z.string().min(1),
    product_name: z.string().min(1).max(200),
    model_id: z.string().max(100),
    unit_price: z.number().nonnegative().nullable(),
    quantity: z.number().int().positive().max(100000),
});

export const CreateAccountQuoteSchema = z.object({
    product_lines: z.array(AccountQuoteLineSchema).min(1, "Add at least one product.").max(100),
    terms: QuoteTermsSchema,
    notes: z.string().trim().max(5000).nullable().optional(),
});
export type CreateAccountQuoteInput = z.infer<typeof CreateAccountQuoteSchema>;

export type CreateAccountQuoteResult = {
    quotationId: string;
    versionNo: number;
    approvalStatus: "approved" | "pending";
    autoApproved: boolean;
    termsHold: TermsHold | null;
    afterCommit: () => Promise<{ quote_number: string | null }>;
};

const lineTotal = (lines: CommercialsProductLine[]) =>
    lines.reduce((s, l) => s + (l.unit_price != null ? l.unit_price * l.quantity : 0), 0);

export async function createAccountQuotation(args: {
    account: AccountSummary;
    actor: { id: string; name: string | null };
    body: CreateAccountQuoteInput;
    performedAt?: Date;
}): Promise<CreateAccountQuoteResult> {
    const { account, actor, body } = args;
    const performedAt = args.performedAt ?? new Date();
    const lines = body.product_lines as CommercialsProductLine[];
    const total = lineTotal(lines);

    const outcome = await db.transaction(async (tx) => {
        // Serialise versions per account: two reps saving at once must not both take max+1.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"account_quote:" + account.id}))`);
        const maxRows = (await tx.execute(sql`
            SELECT MAX(version_no) AS max_v FROM account_quotations WHERE account_id = ${account.id}
        `)) as unknown as Array<{ max_v: number | null }>;
        const versionNo = Number(maxRows[0]?.max_v ?? 0) + 1;

        const standard = await getStandardQuoteTerms(tx);
        const terms = resolveQuoteTerms(body.terms, standard);
        const hold = termsHold(terms);

        const refs = await loadLiveOemPrices(lines, tx, performedAt);
        const evaluation: OemEvaluation = {
            ...evaluateAgainstOemPrices(lines, refs, performedAt),
            terms_hold: hold,
        };
        const decision = applyTermsHold(resolveQuoteApproval(evaluation), hold);
        const listRefs = await loadLiveListPrices(lines, tx, performedAt);
        const snapshotted = snapshotListPrices(lines, listRefs);

        await tx.execute(sql`
            UPDATE account_quotations SET is_current = false, updated_at = NOW()
             WHERE account_id = ${account.id} AND is_current = true
        `);
        const inserted = await tx
            .insert(accountQuotations)
            .values({
                account_id: account.id,
                version_no: versionNo,
                is_current: true,
                event_type: versionNo === 1 ? "quote_issue" : "quote_revision",
                product_lines: snapshotted,
                price_quoted: String(total),
                payment_method: terms.payment_method,
                dealer_payment_terms: terms.dealer_payment_terms,
                credit_days: terms.credit_days,
                credit_terms: terms.credit_terms,
                delivery_terms: terms.delivery_terms,
                warranty_terms: terms.warranty_terms,
                notes: body.notes ?? null,
                approval_status: decision.status,
                approval_mode: decision.mode,
                oem_evaluation: evaluation,
                // Auto-approval stamps the time, approved_by stays NULL: no person approved it.
                approved_at: decision.mode === "auto" ? performedAt : null,
                created_by: actor.id,
            })
            .returning({ id: accountQuotations.quotation_id });
        const quotationId = inserted[0]?.id;
        if (!quotationId) throw new AccountQuoteError("Could not save the quotation.", 500);
        return { quotationId, versionNo, decision, evaluation, hold, terms };
    });

    const afterCommit = async (): Promise<{ quote_number: string | null }> => {
        if (outcome.decision.status === "approved") {
            const draft = await tryGenerateAccountQuotationDraft(outcome.quotationId);
            await notifyAccountQuotationApproved({
                accountId: account.id,
                accountName: account.name,
                quotationId: outcome.quotationId,
                ownerUserId: account.owner_id,
                createdBy: actor.id,
                quoteNumber: draft?.quote_number ?? null,
                value: total,
                mode: "auto",
                draftReady: !!draft,
            });
            return { quote_number: draft?.quote_number ?? null };
        }
        const flagged = linesNeedingAttention(outcome.evaluation);
        const reasons = [
            flagged > 0
                ? `${flagged} line${flagged === 1 ? "" : "s"} below OEM reference, unpriced, or without a reference price`
                : null,
            outcome.hold ? `credit terms (${outcome.hold.credit_days ?? "?"} days) need approval` : null,
        ].filter(Boolean);
        const reason = reasons.length ? reasons.join("; ") : null;
        // 28 Oct item 3 — the approval request to the CEO, CC salesperson,
        // their manager and care@. Never throws.
        const ceoEmailSent = await sendQuoteApprovalRequestEmail({
            family: "account",
            dealerName: account.name,
            refId: account.id,
            versionNo: outcome.versionNo,
            lines,
            termsLabel: termsLabel(outcome.terms),
            notes: body.notes ?? null,
            raisedBy: actor.id,
            raisedByName: actor.name,
            reason,
            href: "/ceo/quotations",
        });
        await notifyAccountQuotationPendingApproval({
            accountId: account.id,
            accountName: account.name,
            quotationId: outcome.quotationId,
            value: total,
            reason,
            raisedByName: actor.name,
            ceoEmailSent,
        });
        return { quote_number: null };
    };

    return {
        quotationId: outcome.quotationId,
        versionNo: outcome.versionNo,
        approvalStatus: outcome.decision.status,
        autoApproved: outcome.decision.mode === "auto",
        termsHold: outcome.hold,
        afterCommit,
    };
}
