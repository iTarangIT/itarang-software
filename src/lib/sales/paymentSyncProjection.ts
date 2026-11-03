/**
 * Vyapar payment sync — Accounts Receivable before and after an upload, for
 * the preview (CEO › Receivables and Invoice Ledger › Import). Read-only.
 *
 * "Before" reads the same rows the receivables page sums (matchedUnion, the
 * REVENUE_OWED rule, the same owe_key); "after" applies exactly what
 * commitImport would write — each invoice's new amount paid and status, a
 * cancelled invoice voided, a register-only invoice added, a credit note's
 * used part (E-368) — and nets again by the same rule
 * (./paymentSyncProjectionRules.ts). Rows the upload can turn back into
 * receivables (an invoice paid in the CRM that Vyapar shows as part-paid) are
 * read too, so "after" is not limited to what is owed today.
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { matchedUnion, OWED_KEY, REVENUE_OWED } from "@/lib/dashboard/revenueSource";
import { GSTIN_KEY } from "@/lib/leads/gstinMatch";
import { hasCreditNoteApplications } from "@/lib/sales/ledgerTables";
import { normalizeInvoiceNumber } from "@/lib/sales/normalizeInvoiceNumber";
import { paymentStatusFor } from "@/lib/sales/paymentStatus";
import { creditNoteAppliedFor } from "@/lib/sales/registerPaymentRules";
import { registerCreditNoteKey, type ImportPreview } from "@/lib/sales/vyaparImport";
import type { ParseResult } from "@/lib/sales/vyaparParse";
import {
    projectReceivable,
    type ProjectionRow,
    type ReceivableProjection,
    type RowOverride,
} from "@/lib/sales/paymentSyncProjectionRules";

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] })?.rows ?? [])) as T[];
const ids = (xs: string[]) => sql.join(xs.map((x) => sql`${x}`), sql`, `);

/** GSTIN → the owe_key the receivables page would give a row carrying it (null when it has none). */
async function oweKeysFor(gstins: string[]): Promise<Map<string, string | null>> {
    const uniq = [...new Set(gstins.filter(Boolean))];
    if (!uniq.length) return new Map();
    const res = rowsOf<{ g: string; k: string | null }>(
        await db.execute(sql`
            SELECT v.g, ${GSTIN_KEY(sql`v.g`)} AS k
              FROM (VALUES ${sql.join(uniq.map((g) => sql`(${g}::text)`), sql`, `)}) AS v(g)`),
    );
    return new Map(res.map((r) => [r.g, r.k]));
}

export async function projectReceivablesAfterImport(parsed: ParseResult, preview: ImportPreview): Promise<ReceivableProjection> {
    const overrides = new Map<string, RowOverride>();
    const added: ProjectionRow[] = [];

    // Invoices: new amount paid, cancelled → void, register-only → added.
    const newInvoices: Array<{ number: string; gstin: string | null; name: string | null; balance: number; status: string }> = [];
    for (const r of preview.rows) {
        if (r.doc_type !== "invoice" || r.action === "in_zoho" || r.action === "gstr1") continue;
        if (r.cancelled) {
            if (r.existing_id) overrides.set(`drive:${r.existing_id}`, { balance: 0, status: "void" });
            continue;
        }
        // E-370: Vyapar's total wins, so the balance after is against it.
        const totalAfter = r.total_after ?? r.crm_total;
        if (totalAfter == null) continue; // no payments in the file for it
        const paid = r.paid_after ?? r.paid_before ?? 0;
        const balance = Math.round((totalAfter - paid) * 100) / 100;
        const status = paymentStatusFor(paid, totalAfter);
        if (r.existing_id) {
            // A duplicate is skipped — nothing it could change.
            const touched = r.classification
                ? r.classification === "updated"
                : r.payment_change === "increase" || r.payment_change === "decrease";
            if (touched) overrides.set(`drive:${r.existing_id}`, { balance, status });
        } else if (r.action === "create") {
            newInvoices.push({ number: r.number, gstin: r.gstin, name: r.party, balance, status });
        }
    }

    // Credit notes (E-368): the used part, on notes the CRM has or the upload adds.
    const applied = await hasCreditNoteApplications();
    const creditDocs = parsed.documents.filter((d) => d.doc_type === "credit_note" && !d.cancelled && d.total != null);
    const creditKeys = creditDocs.map((d) => registerCreditNoteKey(d.number, d.date));
    const existingCredit = new Map<string, { id: string; total: number }>();
    if (creditKeys.length) {
        for (const c of rowsOf<{ k: string; id: string; total: string | null }>(
            await db.execute(sql`
                SELECT note_number_key AS k, id::text AS id, total::text AS total
                  FROM credit_notes WHERE note_number_key IN (${ids(creditKeys)})`),
        )) {
            existingCredit.set(c.k, { id: c.id, total: Number(c.total ?? 0) });
        }
    }
    const newCredits: Array<{ id: string; gstin: string | null; name: string | null; balance: number }> = [];
    for (const d of creditDocs) {
        const key = registerCreditNoteKey(d.number, d.date);
        const used = applied ? (creditNoteAppliedFor(d.total, d.balance_due) ?? 0) : 0;
        const have = existingCredit.get(key);
        if (have) {
            // E-370: Vyapar's total wins on a note the CRM has.
            const total = d.total ?? have.total;
            if (applied || Math.abs(total - have.total) > 1) {
                overrides.set(`credit:${have.id}`, { balance: -(total - Math.min(used, total)), status: "credit_note" });
            }
        } else {
            newCredits.push({ id: `new:${key}`, gstin: d.gstin, name: d.party, balance: -((d.total ?? 0) - Math.min(used, d.total ?? 0)) });
        }
    }

    // Before: what the receivables page sums, plus any row the upload touches.
    const driveIds = [...overrides.keys()].filter((k) => k.startsWith("drive:")).map((k) => k.slice(6));
    const creditIds = [...overrides.keys()].filter((k) => k.startsWith("credit:")).map((k) => k.slice(7));
    const union = await matchedUnion();
    const rows = rowsOf<{ source: string; id: string; owe_key: string; balance: string | null; status: string | null; name: string | null }>(
        await db.execute(sql`
            SELECT r.source, r.id::text AS id, ${OWED_KEY} AS owe_key, COALESCE(r.balance, 0)::text AS balance, r.status,
                   COALESCE(r.dealer_name, r.customer_name) AS name
              FROM ${union} r
             WHERE ${REVENUE_OWED}
                ${driveIds.length ? sql`OR (r.source = 'drive' AND r.id::text IN (${ids(driveIds)}))` : sql``}
                ${creditIds.length ? sql`OR (r.source = 'credit' AND r.id::text IN (${ids(creditIds)}))` : sql``}`),
    ).map((r) => ({ ...r, balance: Number(r.balance ?? 0) }));

    const keys = await oweKeysFor([...newInvoices, ...newCredits].map((x) => x.gstin ?? "").filter(Boolean));
    for (const n of newInvoices) {
        const id = `new:${normalizeInvoiceNumber(n.number) ?? n.number}`;
        added.push({ source: "drive", id, owe_key: keys.get(n.gstin ?? "") ?? `drive:${id}`, balance: n.balance, status: n.status, name: n.name });
    }
    for (const c of newCredits) {
        added.push({ source: "credit", id: c.id, owe_key: keys.get(c.gstin ?? "") ?? `credit:${c.id}`, balance: c.balance, status: "credit_note", name: c.name });
    }
    return projectReceivable(rows, overrides, added);
}
