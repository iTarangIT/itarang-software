/**
 * E-358 — reading account quotations: an account's list, one row with what
 * the send / answer gates need, and its send history.
 *
 * "Live" mirrors LIVE_QUOTE_VERSION on leads (ID 60): approved and not
 * withdrawn. The newest live version is the one a dealer may answer and a rep
 * may send; a revision still at the CEO, rejected or withdrawn replaces nothing.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

export const LIVE_ACCOUNT_QUOTE = sql`q.approval_status = 'approved' AND q.withdrawn_at IS NULL`;

export type AccountQuoteRow = {
    quotation_id: string;
    account_id: string;
    version_no: number;
    is_current: boolean;
    product_lines: unknown;
    price_quoted: string | null;
    total: string | null;
    dealer_payment_terms: string | null;
    credit_days: number | null;
    credit_terms: string | null;
    delivery_terms: string | null;
    warranty_terms: string | null;
    notes: string | null;
    approval_status: string;
    approval_mode: string | null;
    oem_evaluation: unknown;
    approved_at: string | null;
    approved_by_name: string | null;
    rejection_reason: string | null;
    quote_number: string | null;
    quote_pdf_url: string | null;
    quote_pdf_error: string | null;
    dealer_decision: string | null;
    dealer_decision_at: string | null;
    dealer_decision_via: string | null;
    dealer_decision_note: string | null;
    withdrawn_at: string | null;
    withdraw_reason: string | null;
    created_by: string;
    created_by_name: string | null;
    created_at: string;
    is_latest_live: boolean;
    sent_count: number;
};

const SELECT = sql`
    SELECT q.quotation_id::text AS quotation_id, q.account_id, q.version_no, q.is_current,
           q.product_lines, q.price_quoted::text AS price_quoted,
           COALESCE((q.quote_snapshot->>'total')::numeric, q.price_quoted)::text AS total,
           q.dealer_payment_terms, q.credit_days, q.credit_terms, q.delivery_terms, q.warranty_terms, q.notes,
           q.approval_status, q.approval_mode, q.oem_evaluation,
           q.approved_at::text AS approved_at, ap.name AS approved_by_name, q.rejection_reason,
           q.quote_number, q.quote_pdf_url, q.quote_pdf_error,
           q.dealer_decision, q.dealer_decision_at::text AS dealer_decision_at,
           q.dealer_decision_via, q.dealer_decision_note,
           q.withdrawn_at::text AS withdrawn_at, q.withdraw_reason,
           q.created_by::text AS created_by, cu.name AS created_by_name, q.created_at::text AS created_at,
           (${LIVE_ACCOUNT_QUOTE} AND NOT EXISTS (
               SELECT 1 FROM account_quotations q2
                WHERE q2.account_id = q.account_id AND q2.approval_status = 'approved'
                  AND q2.withdrawn_at IS NULL AND q2.version_no > q.version_no
           )) AS is_latest_live,
           (SELECT COUNT(*)::int FROM account_quotation_dispatches d
             WHERE d.quotation_id = q.quotation_id AND d.status = 'sent') AS sent_count
      FROM account_quotations q
      LEFT JOIN users cu ON cu.id = q.created_by
      LEFT JOIN users ap ON ap.id = q.approved_by
`;

export async function listAccountQuotations(accountId: string): Promise<AccountQuoteRow[]> {
    return (await db.execute(sql`${SELECT} WHERE q.account_id = ${accountId} ORDER BY q.version_no DESC LIMIT 100`)) as unknown as AccountQuoteRow[];
}

/** One quotation, scoped to the account in the path (an id from another account is not found). */
export async function loadAccountQuotation(accountId: string, quotationId: string): Promise<AccountQuoteRow | null> {
    const rows = (await db.execute(
        sql`${SELECT} WHERE q.quotation_id = ${quotationId}::uuid AND q.account_id = ${accountId} LIMIT 1`,
    )) as unknown as AccountQuoteRow[];
    return rows[0] ?? null;
}

/** One quotation by id alone — for the signed dealer link and the CEO queue. */
export async function loadAccountQuotationById(quotationId: string): Promise<AccountQuoteRow | null> {
    const rows = (await db.execute(sql`${SELECT} WHERE q.quotation_id = ${quotationId}::uuid LIMIT 1`)) as unknown as AccountQuoteRow[];
    return rows[0] ?? null;
}

/** The account's newest live version (id + number), or null. */
export async function latestLiveAccountQuote(
    accountId: string,
): Promise<{ quotation_id: string; version_no: number; quote_number: string | null } | null> {
    const rows = (await db.execute(sql`
        SELECT q.quotation_id::text AS quotation_id, q.version_no, q.quote_number
          FROM account_quotations q
         WHERE q.account_id = ${accountId} AND ${LIVE_ACCOUNT_QUOTE}
         ORDER BY q.version_no DESC LIMIT 1
    `)) as unknown as Array<{ quotation_id: string; version_no: number; quote_number: string | null }>;
    return rows[0] ?? null;
}

export type AccountDispatchRow = {
    dispatch_id: string;
    channel: string;
    recipient: string;
    status: string;
    error: string | null;
    sent_by_name: string | null;
    created_at: string;
    cc_recipients: string[];
};

export async function listAccountDispatches(quotationId: string): Promise<AccountDispatchRow[]> {
    const rows = (await db.execute(sql`
        SELECT d.dispatch_id::text AS dispatch_id, d.channel, d.recipient, d.status, d.error,
               d.created_at::text AS created_at, u.name AS sent_by_name, d.cc_recipients
          FROM account_quotation_dispatches d
          LEFT JOIN users u ON u.id::text = d.sent_by
         WHERE d.quotation_id = ${quotationId}::uuid
         ORDER BY d.created_at DESC LIMIT 50
    `)) as unknown as Array<Omit<AccountDispatchRow, "cc_recipients"> & { cc_recipients: unknown }>;
    return rows.map((r) => ({ ...r, cc_recipients: Array.isArray(r.cc_recipients) ? r.cc_recipients.map(String) : [] }));
}

/** Why this version may not go to (or be answered by) the dealer, or null when it may. */
export function accountQuoteNotSendable(row: AccountQuoteRow | null): string | null {
    if (!row) return "Quotation not found.";
    if (row.approval_status !== "approved") {
        return `This quotation is ${row.approval_status} and cannot be sent to the account.`;
    }
    if (row.withdrawn_at) return "This quotation has been withdrawn and cannot be sent.";
    if (!row.is_latest_live) return "A newer approved version of this quotation exists. Send the latest version instead.";
    if (!row.quote_pdf_url || !row.quote_number) {
        return "The quotation document has not been generated yet. Regenerate it before sending.";
    }
    return null;
}
