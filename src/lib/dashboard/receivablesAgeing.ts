// Accounts Receivable by age — the pure part of receivables.ts (no database), so
// the netting rule can be unit-tested. receivables.ts re-exports all of it.
//
// ID 89 / 71: credit notes are netted per customer BEFORE bucketing. A
// customer's credit notes are applied to that customer's unpaid invoices,
// oldest invoice first; an invoice fully covered drops out, and credit left
// over once every invoice is covered is ignored (a refund owed is not money
// owed to us). So the age boxes add up to the total exactly, and a credit note
// is never counted as an invoice.

export type AgeingRow = {
    source: string;
    id: string;
    balance: number;
    age_days: number | null;
    /** The customer the balance nets under (GSTIN key, or the row itself). */
    owe_key: string;
};

/** Σ per customer of max(0, Σ balance) — the "Accounts Receivable" figure. */
export function netOwed(rows: Pick<AgeingRow, "owe_key" | "balance">[]): number {
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

export const receivableAgeOf = (r: Pick<AgeingRow, "age_days">): ReceivableAgeKey =>
    r.age_days == null
        ? "no_date"
        : (RECEIVABLE_AGES.find((a) => r.age_days! >= a.min && r.age_days! <= a.max)?.key ?? "0_30");

const isCredit = (r: Pick<AgeingRow, "source" | "balance">) => r.source === "credit" || r.balance < 0;

/**
 * The invoices still owed after each customer's credit notes are applied,
 * oldest invoice first (an undated invoice last). Credit-note rows are not in
 * the result; `balance` is what is left on the invoice.
 */
export function netInvoicesAfterCredits<T extends AgeingRow>(rows: T[]): T[] {
    const credit = new Map<string, number>();
    for (const r of rows) {
        if (isCredit(r)) credit.set(r.owe_key, (credit.get(r.owe_key) ?? 0) - r.balance);
    }
    const invoices = rows
        .filter((r) => !isCredit(r))
        .sort((a, b) => (b.age_days ?? -Infinity) - (a.age_days ?? -Infinity));
    const out: T[] = [];
    for (const r of invoices) {
        const left = credit.get(r.owe_key) ?? 0;
        const used = Math.min(left, r.balance);
        if (used > 0) credit.set(r.owe_key, left - used);
        const balance = r.balance - Math.max(0, used);
        if (balance > 0) out.push({ ...r, balance });
    }
    return out;
}

export type ReceivablesAgeing = {
    owed: number;
    invoices: number;
    buckets: Array<{ key: ReceivableAgeKey; label: string; amount: number; invoices: number }>;
};

/** The ageing buckets; "No invoice date" only when present. Buckets add up to `owed`. */
export function ageReceivables(rows: AgeingRow[]): ReceivablesAgeing {
    const net = netInvoicesAfterCredits(rows);
    const bucket = (key: ReceivableAgeKey, label: string) => {
        const xs = net.filter((r) => receivableAgeOf(r) === key);
        return { key, label, amount: xs.reduce((a, r) => a + r.balance, 0), invoices: xs.length };
    };
    const noDate = bucket("no_date", "No invoice date");
    return {
        owed: netOwed(rows),
        invoices: net.length,
        buckets: [...RECEIVABLE_AGES.map((a) => bucket(a.key, a.label)), ...(noDate.invoices ? [noDate] : [])],
    };
}

// ─────────────── ID 200: where each invoice comes from, and finding a dealer ───────────────

/** What the source of a row is called on the Accounts Receivable page. */
export const RECEIVABLE_SOURCE_LABEL: Record<string, string> = {
    zoho: "Zoho (old)",
    drive: "Drive PDF",
    vyapar: "Vyapar register",
    credit: "Credit note",
};

/** `origin` is `source` with Drive split into the PDF scan and the Vyapar register. */
export function receivableSourceLabel(r: { source: string; origin?: string | null }): string {
    const k = r.origin ?? r.source;
    return RECEIVABLE_SOURCE_LABEL[k] ?? k;
}

/**
 * Shown instead of a file link when the invoice has none: a register-only
 * invoice (read from the Vyapar register, its PDF not yet found by the Drive
 * scan) says so; null when there is a file.
 */
export function receivableFileNote(r: { document_url: string | null; origin?: string | null }): string | null {
    if (r.document_url) return null;
    return r.origin === "vyapar" ? "Register only, no PDF yet" : "No file";
}

/**
 * The page's dealer search: every word must appear in the matched dealer, the
 * customer printed on the invoice, the invoice number, the account id or the
 * GSTIN the balance nets under — case and spacing ignored.
 */
export function matchesReceivableSearch(
    r: {
        dealer_name: string | null;
        customer_name: string | null;
        invoice_number: string | null;
        account_id: string | null;
        owe_key: string;
    },
    q: string,
): boolean {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return true;
    const hay = [r.dealer_name, r.customer_name, r.invoice_number, r.account_id, r.owe_key]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
    return words.every((w) => hay.includes(w));
}
