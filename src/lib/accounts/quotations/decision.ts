/**
 * E-356 — the three state changes on an account quotation after it is raised:
 *
 *   decideAccountQuotation   the CEO approves / rejects a pending version
 *   recordAccountDealerDecision  the account answers a sent version (link / WhatsApp)
 *   withdrawAccountQuotation the sales side withdraws a version
 *
 * Same rules as their lead twins (ceo/quotations/[id]/decision, quoteDecision,
 * withdrawQuote): row locked FOR UPDATE and still pending to decide; a reject
 * rolls is_current back to the newest approved, not-withdrawn version below it
 * (rollbackTarget, reused); a dealer answers once, enforced by
 * WHERE dealer_decision IS NULL, and only the newest live version.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { rollbackTarget, type CommercialVersion } from "@/lib/leads/quoteApproval";
import { AccountQuoteError, loadAccountSummary } from "./access";
import { tryGenerateAccountQuotationDraft } from "./draft";
import {
    notifyAccountQuotationApproved,
    notifyAccountQuotationDealerDecision,
    notifyAccountQuotationRejected,
} from "./notify";
import { LIVE_ACCOUNT_QUOTE, latestLiveAccountQuote, loadAccountQuotationById } from "./store";

export async function decideAccountQuotation(input: {
    quotationId: string;
    decision: "approve" | "reject";
    reason?: string | null;
    actor: { id: string; name: string | null };
}): Promise<{ decision: "approved" | "rejected"; restoredVersion: number | null; quoteNumber: string | null }> {
    const nowIso = new Date().toISOString();
    const outcome = await db.transaction(async (tx) => {
        const locked = (await tx.execute(sql`
            SELECT quotation_id::text AS quotation_id, account_id, version_no, approval_status,
                   price_quoted::text AS price_quoted, created_by::text AS created_by,
                   withdrawn_at::text AS withdrawn_at
              FROM account_quotations WHERE quotation_id = ${input.quotationId}::uuid FOR UPDATE
        `)) as unknown as Array<{
            quotation_id: string;
            account_id: string;
            version_no: number;
            approval_status: string;
            price_quoted: string | null;
            created_by: string;
            withdrawn_at: string | null;
        }>;
        const row = locked[0];
        if (!row) throw new AccountQuoteError("Quotation not found.", 404);
        if (row.withdrawn_at) {
            throw new AccountQuoteError("This quotation was withdrawn by the sales team and can no longer be decided.");
        }
        if (row.approval_status !== "pending") {
            throw new AccountQuoteError(`This quotation is already ${row.approval_status}.`);
        }

        if (input.decision === "approve") {
            await tx.execute(sql`
                UPDATE account_quotations
                   SET approval_status = 'approved', approval_mode = 'manual', approved_by = ${input.actor.id}::uuid,
                       approved_at = ${nowIso}, updated_at = NOW()
                 WHERE quotation_id = ${row.quotation_id}::uuid
            `);
            return { row, restored: null as number | null };
        }

        await tx.execute(sql`
            UPDATE account_quotations
               SET approval_status = 'rejected', approval_mode = 'manual', approved_by = ${input.actor.id}::uuid,
                   approved_at = ${nowIso}, rejection_reason = ${input.reason ?? null},
                   is_current = false, updated_at = NOW()
             WHERE quotation_id = ${row.quotation_id}::uuid
        `);
        const siblings = (await tx.execute(sql`
            SELECT quotation_id::text AS commercial_id, version_no, approval_status, withdrawn_at::text AS withdrawn_at
              FROM account_quotations WHERE account_id = ${row.account_id}
        `)) as unknown as CommercialVersion[];
        const target = rollbackTarget([...siblings], row.version_no);
        if (target) {
            await tx.execute(sql`
                UPDATE account_quotations SET is_current = true, updated_at = NOW()
                 WHERE quotation_id = ${target.commercial_id}::uuid
            `);
        }
        return { row, restored: target?.version_no ?? null };
    });

    // After commit: the document, then who has to act on it. Neither can undo the decision.
    const { row } = outcome;
    const account = await loadAccountSummary(row.account_id);
    const value = Number(row.price_quoted ?? 0);
    if (input.decision === "approve") {
        const draft = await tryGenerateAccountQuotationDraft(row.quotation_id);
        await notifyAccountQuotationApproved({
            accountId: row.account_id,
            accountName: account?.name ?? null,
            quotationId: row.quotation_id,
            ownerUserId: account?.owner_id ?? null,
            createdBy: row.created_by,
            quoteNumber: draft?.quote_number ?? null,
            value,
            mode: "manual",
            approverName: input.actor.name,
            draftReady: !!draft,
        });
        return { decision: "approved", restoredVersion: null, quoteNumber: draft?.quote_number ?? null };
    }
    await notifyAccountQuotationRejected({
        accountId: row.account_id,
        accountName: account?.name ?? null,
        quotationId: row.quotation_id,
        ownerUserId: account?.owner_id ?? null,
        createdBy: row.created_by,
        versionNo: row.version_no,
        value,
        reason: input.reason ?? "",
        rejectorName: input.actor.name,
    });
    return { decision: "rejected", restoredVersion: outcome.restored, quoteNumber: null };
}

export type AccountDealerDecisionResult =
    | { outcome: "recorded" | "already_answered"; quoteNumber: string | null; decision: "approved" | "declined" }
    | { outcome: "not_found" }
    | { outcome: "not_open"; reason: string; latest: { quotation_id: string; version_no: number } | null };

/** The account's answer, once. Never throws for a business reason. */
export async function recordAccountDealerDecision(input: {
    quotationId: string;
    decision: "approved" | "declined";
    via: "link" | "whatsapp";
    actor: string;
    note?: string | null;
}): Promise<AccountDealerDecisionResult> {
    const row = await loadAccountQuotationById(input.quotationId);
    if (!row) return { outcome: "not_found" };
    const latest = async () => {
        const l = await latestLiveAccountQuote(row.account_id);
        return l && l.quotation_id !== row.quotation_id ? { quotation_id: l.quotation_id, version_no: l.version_no } : null;
    };
    if (row.dealer_decision) {
        return { outcome: "already_answered", quoteNumber: row.quote_number, decision: row.dealer_decision as "approved" | "declined" };
    }
    if (row.approval_status !== "approved" || !row.quote_pdf_url) {
        return { outcome: "not_open", reason: "This quotation is no longer open for a response.", latest: await latest() };
    }
    if (row.withdrawn_at) return { outcome: "not_open", reason: "This quotation has been withdrawn.", latest: await latest() };
    if (!row.is_latest_live) {
        return { outcome: "not_open", reason: "This quotation has been replaced. Please respond to the latest one.", latest: await latest() };
    }

    const updated = (await db.execute(sql`
        UPDATE account_quotations AS c
           SET dealer_decision = ${input.decision}, dealer_decision_at = ${new Date().toISOString()},
               dealer_decision_via = ${input.via}, dealer_decision_actor = ${input.actor},
               dealer_decision_note = ${input.note ?? null}, updated_at = NOW()
         WHERE c.quotation_id = ${input.quotationId}::uuid
           AND c.dealer_decision IS NULL AND c.withdrawn_at IS NULL AND c.approval_status = 'approved'
           AND NOT EXISTS (SELECT 1 FROM account_quotations q
                            WHERE q.account_id = c.account_id AND ${LIVE_ACCOUNT_QUOTE} AND q.version_no > c.version_no)
        RETURNING c.quotation_id
    `)) as unknown as unknown[];
    if (updated.length === 0) {
        // Lost a race: report what stands now.
        const fresh = await loadAccountQuotationById(input.quotationId);
        if (fresh?.dealer_decision) {
            return { outcome: "already_answered", quoteNumber: fresh.quote_number, decision: fresh.dealer_decision as "approved" | "declined" };
        }
        return { outcome: "not_open", reason: "This quotation is no longer open for a response.", latest: await latest() };
    }

    const account = await loadAccountSummary(row.account_id);
    await notifyAccountQuotationDealerDecision({
        accountId: row.account_id,
        accountName: account?.name ?? null,
        quotationId: row.quotation_id,
        ownerUserId: account?.owner_id ?? null,
        createdBy: row.created_by,
        quoteNumber: row.quote_number,
        value: Number(row.total ?? row.price_quoted ?? 0),
        decision: input.decision,
        via: input.via,
        note: input.note ?? null,
    });
    return { outcome: "recorded", quoteNumber: row.quote_number, decision: input.decision };
}

/** Withdraw a version (pending or approved, not yet answered). Restores the previous live one as current. */
export async function withdrawAccountQuotation(input: {
    accountId: string;
    quotationId: string;
    reason: string;
    actor: { id: string };
}): Promise<{ restoredVersion: number | null }> {
    return db.transaction(async (tx) => {
        const locked = (await tx.execute(sql`
            SELECT version_no, approval_status, withdrawn_at, dealer_decision, is_current
              FROM account_quotations
             WHERE quotation_id = ${input.quotationId}::uuid AND account_id = ${input.accountId}
             FOR UPDATE
        `)) as unknown as Array<{
            version_no: number;
            approval_status: string;
            withdrawn_at: string | null;
            dealer_decision: string | null;
            is_current: boolean;
        }>;
        const row = locked[0];
        if (!row) throw new AccountQuoteError("Quotation not found.", 404);
        if (row.withdrawn_at) throw new AccountQuoteError("This quotation is already withdrawn.");
        if (row.approval_status === "rejected") throw new AccountQuoteError("A rejected quotation cannot be withdrawn.");
        if (row.dealer_decision === "approved") {
            throw new AccountQuoteError("The account has already approved this quotation; it cannot be withdrawn.");
        }
        await tx.execute(sql`
            UPDATE account_quotations
               SET withdrawn_at = NOW(), withdrawn_by = ${input.actor.id}::uuid, withdraw_reason = ${input.reason},
                   is_current = false, updated_at = NOW()
             WHERE quotation_id = ${input.quotationId}::uuid
        `);
        const siblings = (await tx.execute(sql`
            SELECT quotation_id::text AS commercial_id, version_no, approval_status, withdrawn_at::text AS withdrawn_at
              FROM account_quotations WHERE account_id = ${input.accountId}
        `)) as unknown as CommercialVersion[];
        // Only the current version hands "current" back; withdrawing an older one moves nothing.
        const target = row.is_current ? rollbackTarget([...siblings], row.version_no) : null;
        if (target) {
            await tx.execute(sql`
                UPDATE account_quotations SET is_current = true, updated_at = NOW()
                 WHERE quotation_id = ${target.commercial_id}::uuid
            `);
        }
        return { restoredVersion: target?.version_no ?? null };
    });
}
