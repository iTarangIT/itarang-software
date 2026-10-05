/**
 * E-322 (tracker ID 71 / handover P1-9) — monthly reconciliation of CRM
 * revenue to the filed GSTR-1. "Done when revenue equals GSTR-1 for a closed
 * month, differences listed."
 *
 * CRM side: the revenue union for the month (void invoices excluded, credit
 * notes as negative amounts), exactly what every revenue figure counts.
 * GSTR-1 side: gstr1_entries imported for that month. Documents are paired by
 * normalised number (the dedupe key the invoice import uses); amounts compare
 * on the document value incl. GST, credit notes by absolute value.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { drillDownRows } from "@/lib/dashboard/revenueSource";
import { normalizeInvoiceNumber } from "@/lib/sales/normalizeInvoiceNumber";

export interface ReconDoc {
    key: string;
    number: string;
    date: string | null;
    total: number;
    credit_note: boolean;
    customer?: string | null;
}

export interface ReconResult {
    month: string;
    gstr1_loaded: boolean;
    crm_total: number;
    gstr1_total: number;
    difference: number;
    matched: number;
    missing_in_crm: ReconDoc[];
    missing_in_gstr1: ReconDoc[];
    amount_mismatch: Array<{ number: string; crm: number; gstr1: number; difference: number }>;
}

const TOLERANCE = 1; // ₹ — rounding on the filed figures
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Pure: pair the two sides and list every difference. */
export function reconcile(month: string, crm: ReconDoc[], gstr1: ReconDoc[]): ReconResult {
    const signed = (d: ReconDoc) => (d.credit_note ? -Math.abs(d.total) : Math.abs(d.total));
    const crmBy = new Map<string, ReconDoc>();
    for (const d of crm) crmBy.set(d.key, crmBy.has(d.key) ? { ...d, total: crmBy.get(d.key)!.total + d.total } : d);
    const gBy = new Map<string, ReconDoc>();
    for (const d of gstr1) gBy.set(d.key, gBy.has(d.key) ? { ...d, total: gBy.get(d.key)!.total + d.total } : d);

    const missing_in_crm: ReconDoc[] = [];
    const missing_in_gstr1: ReconDoc[] = [];
    const amount_mismatch: ReconResult["amount_mismatch"] = [];
    let matched = 0;
    for (const [k, g] of gBy) {
        const c = crmBy.get(k);
        if (!c) {
            missing_in_crm.push(g);
            continue;
        }
        const diff = r2(signed(c) - signed(g));
        if (Math.abs(diff) > TOLERANCE) amount_mismatch.push({ number: g.number, crm: r2(signed(c)), gstr1: r2(signed(g)), difference: diff });
        else matched++;
    }
    for (const [k, c] of crmBy) if (!gBy.has(k)) missing_in_gstr1.push(c);

    const crm_total = r2(crm.reduce((s, d) => s + signed(d), 0));
    const gstr1_total = r2(gstr1.reduce((s, d) => s + signed(d), 0));
    const byNumber = (a: ReconDoc, b: ReconDoc) => a.number.localeCompare(b.number);
    return {
        month,
        gstr1_loaded: gstr1.length > 0,
        crm_total,
        gstr1_total,
        difference: r2(crm_total - gstr1_total),
        matched,
        missing_in_crm: missing_in_crm.sort(byNumber),
        missing_in_gstr1: missing_in_gstr1.sort(byNumber),
        amount_mismatch: amount_mismatch.sort((a, b) => a.number.localeCompare(b.number)),
    };
}

/** "YYYY-MM" → its first day and the first day of the next month. */
export function monthWindow(month: string): { from: string; toExcl: string } {
    const m = month.match(/^(\d{4})-(\d{2})$/);
    if (!m) throw new Error(`Invalid month "${month}" — expected YYYY-MM`);
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const next = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`;
    return { from: `${month}-01`, toExcl: `${next}-01` };
}

export async function reconcileMonth(month: string): Promise<ReconResult> {
    const { from, toExcl } = monthWindow(month);
    const crmRows = await drillDownRows("sales", from, toExcl, 20_000);
    const crm: ReconDoc[] = crmRows.map((r) => ({
        key: normalizeInvoiceNumber(r.invoice_number) ?? `#${r.id}`,
        number: r.invoice_number ?? "(no number)",
        date: r.invoice_date ? String(r.invoice_date).slice(0, 10) : null,
        total: Number(r.total ?? 0),
        credit_note: (r.source as string) === "credit",
        customer: r.customer_name,
    }));
    const g = (await db.execute(sql`
        SELECT doc_number, doc_number_key, doc_date::text AS doc_date, total::float8 AS total, doc_type
          FROM gstr1_entries WHERE month = ${from}::date
    `)) as unknown as Array<{ doc_number: string; doc_number_key: string; doc_date: string | null; total: number | null; doc_type: string }>;
    const gstr1: ReconDoc[] = g.map((r) => ({
        key: r.doc_number_key,
        number: r.doc_number,
        date: r.doc_date,
        total: Number(r.total ?? 0),
        credit_note: r.doc_type === "credit_note",
    }));
    return reconcile(month, crm, gstr1);
}
