// Money owed to us — every invoice still owed, read once for the
// /ceo/receivables page and the ageing strip on "Revenue & costs" (ID 89), so
// the two can never bucket the same invoice differently.
//
// Same rule and source as the CEO overview's "Money owed to us" card:
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

export type ReceivableRow = {
    source: string;
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

/** Σ per customer of max(0, Σ balance) — the "Money owed to us" figure. */
export function netOwed(rows: Pick<ReceivableRow, "owe_key" | "balance">[]): number {
    const per = new Map<string, number>();
    for (const r of rows) per.set(r.owe_key, (per.get(r.owe_key) ?? 0) + r.balance);
    let owed = 0;
    for (const v of per.values()) owed += Math.max(0, v);
    return owed;
}

export const RECEIVABLE_AGES = [
    { key: "0_30", label: "0–30 days", min: 0, max: 30 },
    { key: "31_60", label: "31–60 days", min: 31, max: 60 },
    { key: "61_90", label: "61–90 days", min: 61, max: 90 },
    { key: "90_plus", label: "90+ days", min: 91, max: Infinity },
] as const;
export type ReceivableAgeKey = (typeof RECEIVABLE_AGES)[number]["key"] | "no_date";

export const receivableAgeOf = (r: Pick<ReceivableRow, "age_days">): ReceivableAgeKey =>
    r.age_days == null
        ? "no_date"
        : (RECEIVABLE_AGES.find((a) => r.age_days! >= a.min && r.age_days! <= a.max)?.key ?? "0_30");

/** Every invoice still owed (and the credit notes netting it), largest balance first. */
export async function listReceivables(): Promise<ReceivableRow[]> {
    const inv = await matchedUnion();
    // One scan: owed rows, then only the credit notes of customers who still owe.
    const rows = (await db.execute(sql`
        WITH x AS MATERIALIZED (
            SELECT r.*, ${OWED_KEY} AS owe_key, ${REVENUE_OUTSTANDING} AS outstanding
              FROM ${inv} r
             WHERE ${REVENUE_OWED})
        SELECT r.source, r.id, r.invoice_number, r.invoice_date::text AS invoice_date, r.due_date::text AS due_date,
               r.customer_name, COALESCE(r.total, 0) AS total, COALESCE(r.balance, 0) AS balance, r.status,
               r.document_url, r.dealer_lead_id, r.account_id, r.dealer_name, u.name AS owner_name,
               ((now() AT TIME ZONE 'Asia/Kolkata')::date - r.invoice_date::date) AS age_days,
               CASE WHEN r.due_date IS NOT NULL
                    THEN ((now() AT TIME ZONE 'Asia/Kolkata')::date - r.due_date::date) END AS overdue_days,
               r.owe_key
          FROM x r
          LEFT JOIN users u ON u.id::text = r.dealer_owner_id::text
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

export type ReceivablesAgeing = {
    owed: number;
    invoices: number;
    buckets: Array<{ key: ReceivableAgeKey; label: string; amount: number; invoices: number }>;
};

/** The ageing buckets of listReceivables(); "No invoice date" only when present. */
export function ageReceivables(rows: ReceivableRow[]): ReceivablesAgeing {
    const bucket = (key: ReceivableAgeKey, label: string) => {
        const xs = rows.filter((r) => receivableAgeOf(r) === key);
        return { key, label, amount: xs.reduce((a, r) => a + r.balance, 0), invoices: xs.length };
    };
    const noDate = bucket("no_date", "No invoice date");
    return {
        owed: netOwed(rows),
        invoices: rows.filter((r) => r.source !== "credit").length,
        buckets: [...RECEIVABLE_AGES.map((a) => bucket(a.key, a.label)), ...(noDate.invoices ? [noDate] : [])],
    };
}
