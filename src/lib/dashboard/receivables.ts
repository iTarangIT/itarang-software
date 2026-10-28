// Accounts Receivable (was "Money owed to us", ID 200) — every invoice still owed, read once for the
// /ceo/receivables page and the ageing strip on "Revenue & costs" (ID 89), so
// the two can never bucket the same invoice differently.
//
// Same rule and source as the CEO overview's "Accounts Receivable" card:
// outstandingTotal() is SUM(balance) over revenueUnion() WHERE
// REVENUE_OUTSTANDING, all-time. matchedUnion() is that same union plus the
// dealer match, so the total here is the card's number. Ageing is days since
// the invoice date (and days past due where the invoice carries a due date).
//
// ID 71: a non-void credit note is listed beside the unpaid invoices of the
// same customer (GSTIN) as a negative balance, and nets them; a customer's net
// never goes below zero (netOwed), exactly as outstandingTotal() sums it.

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { matchedUnion, OWED_KEY, REVENUE_OUTSTANDING, REVENUE_OWED } from "@/lib/dashboard/revenueSource";

// The pure netting / ageing rules (unit-tested) — re-exported so callers keep
// importing from here.
export {
    ageReceivables,
    netInvoicesAfterCredits,
    netOwed,
    RECEIVABLE_AGES,
    receivableAgeOf,
    receivableFileNote,
    receivableSourceLabel,
    matchesReceivableSearch,
    RECEIVABLE_SOURCE_LABEL,
    type ReceivableAgeKey,
    type ReceivablesAgeing,
} from "@/lib/dashboard/receivablesAgeing";

export type ReceivableRow = {
    source: string;
    /** ID 200: `source` with a Drive row split into 'drive' (PDF scan) or 'vyapar' (register only). */
    origin: string;
    id: string;
    invoice_number: string | null;
    invoice_date: string | null;
    due_date: string | null;
    customer_name: string | null;
    total: number;
    balance: number;
    status: string | null;
    document_url: string | null;
    dealer_lead_id: string | null;
    account_id: string | null;
    dealer_name: string | null;
    owner_name: string | null;
    age_days: number | null;
    overdue_days: number | null;
    /** The customer the balance nets under (GSTIN key, or the row itself). */
    owe_key: string;
};

/** Every invoice still owed (and the credit notes netting it), largest balance first. */
export async function listReceivables(): Promise<ReceivableRow[]> {
    const inv = await matchedUnion();
    // One scan: owed rows, then only the credit notes of customers who still owe.
    const rows = (await db.execute(sql`
        WITH x AS MATERIALIZED (
            SELECT r.*, ${OWED_KEY} AS owe_key, ${REVENUE_OUTSTANDING} AS outstanding
              FROM ${inv} r
             WHERE ${REVENUE_OWED})
        SELECT r.source,
               CASE WHEN r.source = 'drive' AND si.source = 'vyapar' THEN 'vyapar' ELSE r.source END AS origin,
               r.id, r.invoice_number, r.invoice_date::text AS invoice_date, r.due_date::text AS due_date,
               r.customer_name, COALESCE(r.total, 0) AS total, COALESCE(r.balance, 0) AS balance, r.status,
               r.document_url, r.dealer_lead_id, r.account_id, r.dealer_name, u.name AS owner_name,
               ((now() AT TIME ZONE 'Asia/Kolkata')::date - r.invoice_date::date) AS age_days,
               CASE WHEN r.due_date IS NOT NULL
                    THEN ((now() AT TIME ZONE 'Asia/Kolkata')::date - r.due_date::date) END AS overdue_days,
               r.owe_key
          FROM x r
          LEFT JOIN users u ON u.id::text = r.dealer_owner_id::text
          LEFT JOIN sales_invoices si ON r.source = 'drive' AND si.id::text = r.id::text
         WHERE r.owe_key IN (SELECT owe_key FROM x WHERE outstanding)
         ORDER BY r.balance DESC NULLS LAST
    `)) as unknown as Array<Record<string, unknown>>;
    return rows.map(
        (r) =>
            ({
                ...r,
                total: Number(r.total),
                balance: Number(r.balance),
                age_days: r.age_days == null ? null : Number(r.age_days),
                overdue_days: r.overdue_days == null ? null : Number(r.overdue_days),
            }) as ReceivableRow,
    );
}
