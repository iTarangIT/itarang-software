/**
 * E-356 — send an APPROVED account quotation to the account's email and / or
 * WhatsApp. Reuses the lead dispatcher (src/lib/leads/quoteDispatch.ts) with
 * account overrides: the account's own signed link (/quote/a/…), its own
 * WhatsApp button ids, and its own dispatch log. CC: the account owner, the
 * sender, and the admin fixed list (same rules, quotationCcRules.ts).
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { dispatchQuotation, type DispatchOutcome, type QuoteDispatchChannel } from "@/lib/leads/quoteDispatch";
import { getQuotationCcSettings } from "@/lib/leads/quotationCc";
import { buildCcList } from "@/lib/leads/quotationCcRules";
import { accountQuoteApprovalUrl } from "@/lib/leads/quoteToken";
import { AccountQuoteError, type AccountSummary } from "./access";
import { accountQuoteNotSendable, loadAccountQuotation } from "./store";

export const ACCOUNT_QUOTE_APPROVE_PREFIX = "aquote_approve:";
export const ACCOUNT_QUOTE_DECLINE_PREFIX = "aquote_decline:";

async function activeEmail(userId: string | null): Promise<string | null> {
    if (!userId) return null;
    const rows = (await db.execute(sql`
        SELECT email FROM users WHERE id::text = ${userId} AND is_active = true LIMIT 1
    `)) as unknown as Array<{ email: string | null }>;
    return rows[0]?.email ?? null;
}

export async function sendAccountQuotation(input: {
    account: AccountSummary;
    quotationId: string;
    channels: QuoteDispatchChannel[];
    email?: string | null;
    phone?: string | null;
    message?: string | null;
    extraCc?: string[];
    actor: { id: string; name: string | null };
}): Promise<{ quote_number: string; outcomes: DispatchOutcome[]; sent_count: number; failed_count: number }> {
    const { account, actor } = input;
    const row = await loadAccountQuotation(account.id, input.quotationId);
    const refused = accountQuoteNotSendable(row);
    if (refused || !row) throw new AccountQuoteError(refused ?? "Quotation not found.", row ? 409 : 404);

    const email = input.email?.trim() || account.contact_email;
    const phone = input.phone?.trim() || account.contact_phone;

    let cc: string[] = [];
    try {
        const [ownerEmail, actorEmail, fixed] = await Promise.all([
            activeEmail(account.owner_id),
            activeEmail(actor.id),
            getQuotationCcSettings(),
        ]);
        cc = buildCcList({ ownerEmail, actorEmail, fixed: fixed.emails, extra: input.extraCc ?? [], dealerEmail: email });
    } catch (e) {
        // A CC is a courtesy copy; it never stops the quotation going out.
        console.warn("[accountQuote/send] CC not resolved — sending without", e);
    }

    let approvalUrl: string | null = null;
    try {
        approvalUrl = accountQuoteApprovalUrl({ quotationId: row.quotation_id, versionNo: row.version_no });
    } catch (e) {
        console.error("[accountQuote/send] approval link unavailable", e);
    }

    const total = row.total == null ? null : Number(row.total);
    const outcomes = await dispatchQuotation({
        commercialId: row.quotation_id,
        dealerLeadId: account.id,
        versionNo: row.version_no,
        quoteNumber: row.quote_number!,
        pdfUrl: row.quote_pdf_url!,
        dealerName: account.name,
        channels: input.channels,
        email,
        phone,
        message: input.message,
        cc,
        quoteTotal: Number.isFinite(total) ? total : null,
        senderName: actor.name,
        sentBy: actor.id,
        approvalUrl,
        buttonIds: {
            approve: `${ACCOUNT_QUOTE_APPROVE_PREFIX}${row.quotation_id}`,
            decline: `${ACCOUNT_QUOTE_DECLINE_PREFIX}${row.quotation_id}`,
        },
        logRow: async (o, rowCc) => {
            await db.execute(sql`
                INSERT INTO account_quotation_dispatches
                    (quotation_id, account_id, channel, recipient, status, provider_message_id, error, sent_by, cc_recipients)
                VALUES (${row.quotation_id}::uuid, ${account.id}, ${o.channel}, ${o.recipient}, ${o.status},
                        ${o.providerMessageId ?? null}, ${o.error ?? null}, ${actor.id},
                        ${rowCc ? JSON.stringify(rowCc) : null}::jsonb)
            `);
        },
    });

    const sent = outcomes.filter((o) => o.status === "sent");
    // Remember a corrected email on the account only once it actually went.
    if (input.email && input.email !== account.contact_email && sent.some((o) => o.channel === "email")) {
        try {
            await db.execute(sql`UPDATE accounts SET contact_email = ${input.email}, updated_at = NOW() WHERE id = ${account.id}`);
        } catch (e) {
            console.error("[accountQuote/send] could not save the account email", e);
        }
    }
    return {
        quote_number: row.quote_number!,
        outcomes,
        sent_count: sent.length,
        failed_count: outcomes.length - sent.length,
    };
}
